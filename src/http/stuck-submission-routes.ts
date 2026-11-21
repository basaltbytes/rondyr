import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { StuckSubmissions } from "../domain/submissions/operations-status.ts";
import { OrganizationId, SubmissionId } from "../domain/submissions/submission.id.ts";
import { retryStuckSubmission } from "../jobs/submission-outbox.ts";
import { OperationsStore } from "../ports/operations-status.ts";
import { StuckSubmissionNotFound } from "../ports/outbox.ts";
import { reviewer } from "./review-routes.ts";

const OrganizationPath = Schema.Struct({ organizationId: OrganizationId });
const SubmissionPath = OrganizationPath.mapFields((fields) => ({
  ...fields,
  submissionId: SubmissionId,
}));

const jsonOptions = { headers: { "cache-control": "no-store" } };
const stuckJson = HttpServerResponse.schemaJson(StuckSubmissions);

function empty(status: number) {
  return Effect.succeed(HttpServerResponse.empty({ status, ...jsonOptions }));
}

const withErrors = <A, E, R>(route: Effect.Effect<A, E, R>) =>
  route.pipe(
    Effect.catchCause((cause) => {
      const error = cause.reasons.find((reason) => reason._tag === "Fail");
      if (error === undefined) return empty(503);
      return Effect.catchTags(Effect.fail(error.error), {
        ReviewUnauthorized: () => empty(401),
        AuthOriginRefused: () => empty(403),
        StuckSubmissionNotFound: () => empty(404),
        SubmissionNotStuck: () => empty(409),
        SchemaError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/**
 * The account that reads and retries the stuck submissions of an organization.
 * Every member may do both; the roles of #11 restrict them here. The adapters
 * also check the organization in each query.
 */
const stuckOperator = Effect.fn("StuckSubmissionRoute.operator")(function* (
  organizationId: OrganizationId,
) {
  const { userId, organizations } = yield* reviewer();
  if (!organizations.some(({ id }) => id === organizationId)) {
    return yield* StuckSubmissionNotFound.make();
  }
  return userId;
});

const list = Effect.gen(function* () {
  const { organizationId } = yield* HttpRouter.schemaPathParams(OrganizationPath);
  const userId = yield* stuckOperator(organizationId);
  const store = yield* OperationsStore;
  const stuck = yield* store.stuck(userId, organizationId);
  return yield* stuckJson(stuck, jsonOptions);
});

const retry = Effect.gen(function* () {
  const scope = yield* HttpRouter.schemaPathParams(SubmissionPath);
  const userId = yield* stuckOperator(scope.organizationId);
  yield* retryStuckSubmission(scope);
  const store = yield* OperationsStore;
  const stuck = yield* store.stuck(userId, scope.organizationId);
  return yield* stuckJson(stuck, jsonOptions);
});

const stuckSubmissions = "/api/organizations/:organizationId/stuck-submissions";

export const stuckSubmissionRoutes = Layer.mergeAll(
  HttpRouter.add("GET", stuckSubmissions, withErrors(list)),
  HttpRouter.add("POST", `${stuckSubmissions}/:submissionId/retry`, withErrors(retry)),
);
