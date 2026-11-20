import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { isWorkerEvent } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import * as DomainCloudflare from "@alchemy.run/domain/Cloudflare";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

import { classifierLive } from "./adapters/ai/classifier.ts";
import { authenticationLive } from "./adapters/authentication/better-auth.ts";
import { inboxStoreLive } from "./adapters/database/inbox.ts";
import { submissionIntakeLive } from "./adapters/database/intake.ts";
import { organizationDirectoryLive } from "./adapters/database/organization-directory.ts";
import { outboxLive } from "./adapters/database/outbox.ts";
import { storedMessagesLive } from "./adapters/database/stored-messages.ts";
import { classificationQueueLive } from "./adapters/queues/classification-queue.ts";
import { eventBackgroundTasks } from "./adapters/workers/background-tasks.ts";
import { Submissions, submissionHandlers } from "./domain/submissions/submissions.model.ts";
import { authenticationRoutes } from "./http/authentication.ts";
import { publicRoutes } from "./http/public-routes.ts";
import { reviewRoutes } from "./http/review-routes.ts";
import { submissionRoutes } from "./http/submission-routes.ts";
import { consumeSubmissions, publishPendingSubmissions } from "./jobs/submission-outbox.ts";
import { BackgroundTasks } from "./ports/background-tasks.ts";

const services = Layer.mergeAll(
  authenticationLive,
  HttpServer.layerServices,
  submissionIntakeLive,
  organizationDirectoryLive,
  outboxLive,
  classificationQueueLive,
  Submissions.layer(submissionHandlers, { legacyData: false }).pipe(
    Layer.provide(
      Layer.mergeAll(
        DomainCloudflare.layerDurableObjects(),
        classifierLive.pipe(Layer.provide(storedMessagesLive)),
        inboxStoreLive,
      ),
    ),
  ),
);
const routes = Layer.mergeAll(publicRoutes, authenticationRoutes, submissionRoutes, reviewRoutes);

export const workerImplementation = Effect.gen(function* () {
  const context = yield* Layer.build(services);
  const router = yield* HttpRouter.toHttpEffect(routes);
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
      return publishPendingSubmissions().pipe(Effect.provideContext(context), Effect.orDie);
    }
    if (event.type === "queue") {
      return consumeSubmissions(event.input).pipe(Effect.provideContext(context));
    }
  });

  return { fetch };
});
