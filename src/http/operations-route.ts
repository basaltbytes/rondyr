import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { OperationsStatus } from "../domain/submissions/operations-status.ts";
import { UserId } from "../domain/submissions/submission.id.ts";
import { Authentication } from "../ports/authentication.ts";
import { CronHeartbeat, OperationsStore } from "../ports/operations-status.ts";

const options = { headers: { "cache-control": "no-store" } };

const status = Effect.gen(function* () {
  const auth = yield* Authentication;
  const incoming = yield* HttpServerRequest.HttpServerRequest;
  const request = yield* HttpServerRequest.toWeb(incoming);
  const user = yield* auth.userId(request);
  if (user === null) return HttpServerResponse.empty({ status: 401, ...options });
  const userId = yield* UserId.makeEffect(user);
  const store = yield* OperationsStore;
  const heartbeat = yield* CronHeartbeat;
  const snapshot = yield* Effect.all(
    { organizations: store.read(userId), lastSuccessfulCronAt: heartbeat.read },
    { concurrency: "unbounded" },
  );
  return yield* HttpServerResponse.schemaJson(OperationsStatus)(snapshot, options);
}).pipe(
  Effect.catchTag("AuthOriginRefused", () =>
    Effect.succeed(HttpServerResponse.empty({ status: 403, ...options })),
  ),
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503, ...options })),
);

export const operationsRoute = HttpRouter.add("GET", "/api/operations", status);
