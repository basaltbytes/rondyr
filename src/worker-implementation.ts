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
import { cronHeartbeatLive } from "./adapters/workers/cron-heartbeat.ts";
import { turnstileVerifierLive } from "./adapters/workers/siteverify.ts";
import { Submissions, submissionHandlers } from "./domain/submissions/submissions.model.ts";
import { apiTokenAuthentication } from "./http/api-token-authentication.ts";
import { apiTokenRoutes } from "./http/api-token-routes.ts";
import { authenticationRoutes } from "./http/authentication.ts";
import { classificationPolicyRoutes } from "./http/classification-policy-routes.ts";
import { deliveryRoutes } from "./http/delivery-routes.ts";
import { formRoutes } from "./http/form-routes.ts";
import { invitationRoutes } from "./http/invitation-routes.ts";
import { memberRoutes } from "./http/member-routes.ts";
import { operationsRoute } from "./http/operations-route.ts";
import { organizationDomainRoutes } from "./http/organization-domain-routes.ts";
import { organizationQuotaRoutes } from "./http/organization-quota-routes.ts";
import { originRoutes } from "./http/origin-routes.ts";
import { publicRoutes } from "./http/public-routes.ts";
import { reviewRoutes } from "./http/review-routes.ts";
import { submissionRoutes } from "./http/submission-routes.ts";
import { targetRoutes } from "./http/target-routes.ts";
import { consumeDeliveries, deliverySchedulerLive } from "./jobs/delivery-outbox.ts";
import { publishOutboxes } from "./jobs/publish-outboxes.ts";
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
  formOriginsLive,
  formsLive.pipe(Layer.provide([secretCipherLive, turnstile])),
  organizationDirectoryLive,
  membersLive,
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
    Layer.provide(Layer.mergeAll(secretCipherLive, emailSenderLive)),
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
const routes = Layer.mergeAll(
  publicRoutes,
  authenticationRoutes,
  apiTokenRoutes,
  submissionRoutes,
  reviewRoutes,
  targetRoutes,
  originRoutes,
  organizationDomainRoutes,
  organizationQuotaRoutes,
  classificationPolicyRoutes,
  formRoutes,
  deliveryRoutes,
  memberRoutes,
  invitationRoutes,
  operationsRoute,
).pipe(Layer.provide(apiTokenAuthentication));

const consumeBatch = Effect.fn("Queue.consume")(function* (batch: MessageBatch) {
  const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
  if (batch.queue === env.DELIVERY_QUEUE_NAME) return yield* consumeDeliveries(batch);
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
      return publishOutboxes().pipe(Effect.provideContext(context));
    }
    if (event.type === "queue") {
      return consumeBatch(event.input).pipe(Effect.provideContext(context));
    }
  });

  return { fetch };
});
