import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { allows } from "../domain/organizations/member-role.ts";
import { OperationsStatus } from "../domain/submissions/operations-status.ts";
import { CronHeartbeat, OperationsStore } from "../ports/operations-status.ts";
import { OrganizationDirectory } from "../ports/organization-directory.ts";
import { signedInAccount } from "./organization-access.ts";

const options = { headers: { "cache-control": "no-store" } };

/** The processing status of the organizations that the account administers. */
const status = Effect.gen(function* () {
  const userId = yield* signedInAccount();
  const directory = yield* OrganizationDirectory;
  const memberships = yield* directory.organizationsFor(userId);
  const administered = memberships
    .filter(({ role }) => allows(role, "read-operations"))
    .map(({ id }) => id);
  const store = yield* OperationsStore;
  const heartbeat = yield* CronHeartbeat;
  const snapshot = yield* Effect.all(
    { organizations: store.read(administered), lastSuccessfulCronAt: heartbeat.read },
    { concurrency: "unbounded" },
  );
  return yield* HttpServerResponse.schemaJson(OperationsStatus)(snapshot, options);
}).pipe(
  Effect.catchTags({
    ReviewUnauthorized: () => Effect.succeed(HttpServerResponse.empty({ status: 401, ...options })),
    AuthOriginRefused: () => Effect.succeed(HttpServerResponse.empty({ status: 403, ...options })),
  }),
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503, ...options })),
);

export const operationsRoute = HttpRouter.add("GET", "/api/operations", status);
