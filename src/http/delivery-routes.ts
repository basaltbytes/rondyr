import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { DeliveryId, TargetId } from "../domain/deliveries/delivery.ts";
import { DeliveryRecord, TargetTestResult } from "../domain/deliveries/history.ts";
import { OrganizationId, SubmissionId } from "../domain/submissions/submission.id.ts";
import { retryDelivery, sendTestNotification } from "../jobs/delivery-outbox.ts";
import { DeliveryHistory } from "../ports/delivery-history.ts";
import { DeliveryNotFound } from "../ports/delivery-store.ts";
import { NotificationTargets } from "../ports/notification-targets.ts";
import { reviewer } from "./review-routes.ts";

const SubmissionPath = Schema.Struct({
  organizationId: OrganizationId,
  submissionId: SubmissionId,
});
const DeliveryPath = SubmissionPath.mapFields((fields) => ({ ...fields, deliveryId: DeliveryId }));
const TargetPath = Schema.Struct({ organizationId: OrganizationId, targetId: TargetId });

/** A test of this target is running in this Worker instance. */
class TestRunning extends Schema.TaggedError<TestRunning, { readonly brand: unique symbol }>()(
  "TestRunning",
  {},
) {}

const jsonOptions = { headers: { "cache-control": "no-store" } };
const historyJson = HttpServerResponse.schemaJson(Schema.Array(DeliveryRecord));
const testJson = HttpServerResponse.schemaJson(TargetTestResult);

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
        DeliveryNotFound: () => empty(404),
        TargetNotFound: () => empty(404),
        DeliveryNotRetryable: () => empty(409),
        TestRunning: () => empty(409),
        SchemaError: () => empty(400),
      }).pipe(Effect.catch(() => empty(503)));
    }),
  );

/**
 * The account that reads the deliveries of an organization, retries them, and
 * tests its targets. Every member may do all three; the roles of #11 restrict
 * them here. The adapters also check membership in each query.
 */
const deliveryOperator = Effect.fn("DeliveryRoute.operator")(function* (
  organizationId: OrganizationId,
) {
  const { userId, organizations } = yield* reviewer();
  if (!organizations.some(({ id }) => id === organizationId)) {
    return yield* DeliveryNotFound.make();
  }
  return userId;
});

const history = Effect.gen(function* () {
  const path = yield* HttpRouter.schemaPathParams(SubmissionPath);
  const userId = yield* deliveryOperator(path.organizationId);
  const deliveries = yield* DeliveryHistory;
  const records = yield* deliveries.list({ userId, ...path });
  return yield* historyJson(records, jsonOptions);
});

const retry = Effect.gen(function* () {
  const path = yield* HttpRouter.schemaPathParams(DeliveryPath);
  const userId = yield* deliveryOperator(path.organizationId);
  yield* retryDelivery({ userId, ...path });
  const deliveries = yield* DeliveryHistory;
  const records = yield* deliveries.list({ userId, ...path });
  return yield* historyJson(records, jsonOptions);
});

const submissionDeliveries =
  "/api/organizations/:organizationId/submissions/:submissionId/deliveries";

export const deliveryRoutes = Layer.unwrap(
  Effect.sync(() => {
    // One test at a time per target, in this Worker instance.
    const testing = new Set<string>();
    const claim = (targetId: string) =>
      Effect.suspend(() => {
        if (testing.has(targetId)) return Effect.fail(TestRunning.make());
        testing.add(targetId);
        return Effect.void;
      });
    const release = (targetId: string) =>
      Effect.sync(() => {
        testing.delete(targetId);
      });

    const test = Effect.gen(function* () {
      const { organizationId, targetId } = yield* HttpRouter.schemaPathParams(TargetPath);
      const userId = yield* deliveryOperator(organizationId);
      const targets = yield* NotificationTargets;
      const testable = yield* targets.testable({ userId, organizationId, targetId });
      const result = yield* Effect.acquireUseRelease(
        claim(testable.target.id),
        () => sendTestNotification(testable),
        () => release(testable.target.id),
      );
      return yield* testJson(result, jsonOptions);
    });

    return Layer.mergeAll(
      HttpRouter.add("GET", submissionDeliveries, withErrors(history)),
      HttpRouter.add("POST", `${submissionDeliveries}/:deliveryId/retry`, withErrors(retry)),
      HttpRouter.add(
        "POST",
        "/api/organizations/:organizationId/targets/:targetId/test",
        withErrors(test),
      ),
    );
  }),
);
