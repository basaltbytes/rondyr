import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { isWorkerEvent } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

import { classifierLive } from "./adapters/ai/classifier.ts";
import { authenticationLive } from "./adapters/authentication/better-auth.ts";
import { secretCipherLive } from "./adapters/crypto/secret-cipher.ts";
import { apiTokensLive } from "./adapters/database/api-tokens.ts";
import { classificationPoliciesLive } from "./adapters/database/classification-policies.ts";
import { deliveryHistoryLive } from "./adapters/database/delivery-history.ts";
import { deliveryStoreLive } from "./adapters/database/delivery-store.ts";
import { formOriginsLive } from "./adapters/database/form-origins.ts";
import { formsLive } from "./adapters/database/forms.ts";
import { inboxStoreLive } from "./adapters/database/inbox.ts";
import { membersLive } from "./adapters/database/members.ts";
import { passwordResetsLive } from "./adapters/database/password-resets.ts";
import { recipientConfirmationsLive } from "./adapters/database/recipient-confirmations.ts";
import { submissionExportsLive } from "./adapters/database/submission-exports.ts";
import { submissionRetentionLive } from "./adapters/database/submission-retention.ts";
import { submissionIntakeLive } from "./adapters/database/intake.ts";
import { notificationTargetsLive } from "./adapters/database/notification-targets.ts";
import { operationsStoreLive } from "./adapters/database/operations-status.ts";
import { organizationDirectoryLive } from "./adapters/database/organization-directory.ts";
import { organizationQuotasLive } from "./adapters/database/organization-quotas.ts";
import { outboxLive } from "./adapters/database/outbox.ts";
import { storedMessagesLive } from "./adapters/database/stored-messages.ts";
import { emailSenderLive } from "./adapters/email/email-sender.ts";
import { notificationProvidersLive } from "./adapters/notifications/notification-providers.ts";
import { classificationQueueLive } from "./adapters/queues/classification-queue.ts";
import { deliveryQueueLive } from "./adapters/queues/delivery-queue.ts";
import { eventBackgroundTasks } from "./adapters/workers/background-tasks.ts";
import { clientRateLimitLive } from "./adapters/workers/client-rate-limit.ts";
import { testSendLimitLive } from "./adapters/workers/test-send-limit.ts";
import { cronHeartbeatLive } from "./adapters/workers/cron-heartbeat.ts";
import { turnstileVerifierLive } from "./adapters/workers/siteverify.ts";
import { Submissions, submissionHandlers } from "./domain/submissions/submissions.model.ts";
import { apiTokenAuthentication } from "./http/api-token-authentication.ts";
import { routes as applicationRoutes } from "./http/routes.ts";
import { consumeDeadLetters } from "./jobs/dead-letters.ts";
import { consumeDeliveries, deliverySchedulerLive } from "./jobs/delivery-outbox.ts";
import { publishOutboxes } from "./jobs/publish-outboxes.ts";
import { purgeOnTheHour } from "./jobs/retention-purge.ts";
import { consumeSubmissions } from "./jobs/submission-outbox.ts";
import { BackgroundTasks } from "./ports/background-tasks.ts";

const deliveries = Layer.mergeAll(deliveryStoreLive, deliveryQueueLive);
const turnstile = turnstileVerifierLive.pipe(
  Layer.provide([secretCipherLive, FetchHttpClient.layer]),
);
const services = Layer.mergeAll(
  authenticationLive,
  apiTokensLive,
  HttpServer.layerServices,
  submissionIntakeLive.pipe(Layer.provide(turnstile)),
  clientRateLimitLive,
  testSendLimitLive,
  recipientConfirmationsLive,
  submissionExportsLive,
  submissionRetentionLive,
  formOriginsLive,
  formsLive.pipe(Layer.provide([secretCipherLive, turnstile])),
  organizationDirectoryLive,
  membersLive,
  passwordResetsLive,
  organizationQuotasLive,
  classificationPoliciesLive,
  outboxLive,
  classificationQueueLive,
  deliveries,
  deliveryHistoryLive,
  operationsStoreLive,
  cronHeartbeatLive,
  emailSenderLive,
  Layer.mergeAll(notificationProvidersLive, notificationTargetsLive).pipe(
    Layer.provide(Layer.mergeAll(secretCipherLive, emailSenderLive, recipientConfirmationsLive)),
  ),
  Submissions.layer(submissionHandlers, { legacyData: false }).pipe(
    Layer.provide(
      Layer.mergeAll(
        DomainCloudflare.layerDurableObjects(),
        classifierLive.pipe(
          Layer.provide(
            Layer.mergeAll(storedMessagesLive, classificationPoliciesLive, organizationQuotasLive),
          ),
        ),
        inboxStoreLive,
        deliverySchedulerLive.pipe(Layer.provide(deliveries)),
      ),
    ),
  ),
);
const routes = applicationRoutes.pipe(Layer.provide(apiTokenAuthentication));

const consumeBatch = Effect.fn("Queue.consume")(function* (batch: MessageBatch) {
  const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
  if (batch.queue === env.DELIVERY_QUEUE_NAME) return yield* consumeDeliveries(batch);
  if (batch.queue === env.CLASSIFICATION_DEAD_LETTER_QUEUE_NAME) {
    return yield* consumeDeadLetters("classification", batch);
  }
  if (batch.queue === env.DELIVERY_DEAD_LETTER_QUEUE_NAME) {
    return yield* consumeDeadLetters("delivery", batch);
  }
  // Classification is the default, as it was when the Worker had one consumer: a wrong
  // queue name in the environment is logged and cannot stop classification. A message
  // of another queue does not decode there and is retried, then dead-lettered.
  if (batch.queue !== env.CLASSIFICATION_QUEUE_NAME) {
    yield* Effect.logError("Queue batch from an unknown queue", { queue: batch.queue });
  }
  return yield* consumeSubmissions(batch);
});

export const workerImplementation = Effect.gen(function* () {
  const context = yield* Layer.build(services);
  const router = yield* HttpRouter.toHttpEffect(routes).pipe(Effect.provideContext(context));
  const fetch = router.pipe(
    Effect.provideServiceEffect(BackgroundTasks, eventBackgroundTasks),
    Effect.provideContext(context),
    Effect.catchTags({
      HttpServerError: ({ reason }) =>
        Effect.succeed(
          HttpServerResponse.empty({ status: reason._tag === "RouteNotFound" ? 404 : 500 }),
        ),
      RouteNotFound: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
    }),
    Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 })),
    // The Worker answers /health, /f and /api. public/_headers covers the dashboard assets.
    Effect.map(HttpServerResponse.setHeader("x-content-type-options", "nosniff")),
  );

  const worker = yield* Worker;
  yield* worker.listen((event) => {
    if (!isWorkerEvent(event)) return;
    if (event.type === "scheduled") {
      // The purge never fails the Cron, and runs whatever the publication did. It
      // goes by the scheduled time, which a slow publication does not move.
      return publishOutboxes().pipe(
        Effect.ensuring(purgeOnTheHour(event.input.scheduledTime)),
        Effect.provideContext(context),
      );
    }
    if (event.type === "queue") {
      return consumeBatch(event.input).pipe(Effect.provideContext(context));
    }
  });

  return { fetch };
});
