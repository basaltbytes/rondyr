import { Clock, Context, Effect, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import {
  afterAttempt,
  DeliveryId,
  maxDeliveryAttempts,
  summarize,
  type AttemptOutcome,
} from "../../domain/deliveries/delivery.ts";
import type { TargetTestResult } from "../../domain/deliveries/history.ts";
import {
  DeliveriesUnavailable,
  DeliveryScheduler,
} from "../../domain/submissions/delivery-scheduler.external.ts";
import type { SubmissionId } from "../../domain/submissions/submission.id.ts";
import { DeliveryQueue } from "../ports/delivery-queue.ts";
import { DeliveryStore, type DeliveryScope } from "../ports/delivery-store.ts";
import { NotificationFailed, NotificationProvider } from "../ports/notification-provider.ts";
import type { TestableTarget } from "../ports/notification-targets.ts";
import type { OutboxLease } from "../ports/outbox.ts";

const decodeMessage = Schema.decodeUnknownEffect(Schema.Struct({ deliveryId: DeliveryId }));

// Publication follows the submission outbox: a one-minute claim, and a published
// delivery that no attempt has taken after five minutes is published again.
const leaseFor = (now: number): OutboxLease => ({
  now,
  until: now + 60_000,
  republishBefore: now - 300_000,
});

/** An attempt that never records its result may be started again after two minutes. */
const attemptLeaseMillis = 120_000;

/** A provider that does not answer in time counts as a retryable failure. */
const providerTimeout = "30 seconds";

const timedOut = () =>
  NotificationFailed.make({
    retryable: true,
    summary: `The provider did not answer within ${providerTimeout}.`,
  });

const publishClaimed = Effect.fnUntraced(function* (
  lease: OutboxLease,
  deliveryIds: ReadonlyArray<DeliveryId>,
) {
  if (deliveryIds.length === 0) return;
  const store = yield* DeliveryStore;
  const queue = yield* DeliveryQueue;
  yield* queue.send(deliveryIds);
  yield* store.markPublished(lease, deliveryIds);
});

/** Cron path: publish up to 100 due deliveries, including retries whose delay is over. */
export const publishPendingDeliveries = Effect.fn("Deliveries.publish")(function* () {
  const store = yield* DeliveryStore;
  const now = yield* Clock.currentTimeMillis;
  const lease = leaseFor(now);
  const deliveryIds = yield* store.claimDue(lease, 100);
  yield* publishClaimed(lease, deliveryIds);
});

const publishSubmission = Effect.fn("Deliveries.publishSubmission")(function* (
  submissionId: SubmissionId,
) {
  const store = yield* DeliveryStore;
  const now = yield* Clock.currentTimeMillis;
  const lease = leaseFor(now);
  const deliveryIds = yield* store.claimSubmission(lease, submissionId);
  yield* publishClaimed(lease, deliveryIds);
});

/**
 * The scheduler that the `Delivery` policy calls: store the deliveries first,
 * then publish them. The cron publishes them later if this publication fails.
 */
export const deliverySchedulerLive = DeliveryScheduler.toLayer(
  Effect.gen(function* () {
    const context = yield* Effect.context<DeliveryStore | DeliveryQueue>();
    const store = Context.get(context, DeliveryStore);
    return {
      schedule: Effect.fn("DeliveryScheduler.schedule")(function* (accepted) {
        const now = yield* Clock.currentTimeMillis;
        const targets = yield* store
          .create(accepted, now)
          .pipe(Effect.mapError(() => DeliveriesUnavailable.make()));
        // Without an active target the acceptance changes nothing outside the Inbox.
        if (targets === 0) return;
        yield* publishSubmission(accepted.submissionId).pipe(
          Effect.provideContext(context),
          Effect.tapError((error) =>
            Effect.logWarning("Direct delivery publication failed", {
              submissionId: accepted.submissionId,
              tag: error._tag,
            }),
          ),
          Effect.ignore,
        );
      }),
    };
  }),
);

/**
 * Retry a failed delivery by hand: a new series of attempts with the same
 * delivery ID, published as the policy publishes a new delivery. The cron
 * publishes it later if this publication fails.
 */
export const retryDelivery = Effect.fn("Deliveries.retry")(function* (delivery: DeliveryScope) {
  yield* Effect.annotateCurrentSpan({ deliveryId: delivery.deliveryId });
  const store = yield* DeliveryStore;
  const now = yield* Clock.currentTimeMillis;
  yield* store.retry(delivery, now);
  yield* Effect.logInfo("Delivery retried by hand", { deliveryId: delivery.deliveryId });
  yield* publishSubmission(delivery.submissionId).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Direct delivery publication failed", {
        deliveryId: delivery.deliveryId,
        tag: error._tag,
      }),
    ),
    Effect.ignore,
  );
});

/**
 * Send a test message to a target and wait for its result. Nothing is stored:
 * the test has its own new ID and no delivery.
 */
export const sendTestNotification = Effect.fn("Deliveries.sendTest")(function* (
  testable: TestableTarget,
) {
  const provider = yield* NotificationProvider;
  const testId = DeliveryId.make(SecureRandom.uuidV4Unsafe());
  yield* Effect.annotateCurrentSpan({ testId, targetId: testable.target.id });
  const result = yield* provider.sendTest({ testId, ...testable }).pipe(
    Effect.timeoutOrElse({ duration: providerTimeout, orElse: () => Effect.fail(timedOut()) }),
    Effect.match({
      onSuccess: (): typeof TargetTestResult.Type => ({ testId, outcome: "delivered" }),
      onFailure: (failure): typeof TargetTestResult.Type => ({
        testId,
        outcome: failure.retryable ? "retryable-failure" : "permanent-failure",
        summary: summarize(failure.summary),
      }),
    }),
  );
  yield* Effect.logInfo("Test message sent", {
    testId,
    targetId: testable.target.id,
    outcome: result.outcome,
  });
  return result;
});

const outcomeOf = (failure: NotificationFailed): typeof AttemptOutcome.Type =>
  failure.retryable
    ? { _tag: "RetryableFailure", summary: failure.summary }
    : { _tag: "PermanentFailure", summary: failure.summary };

const attemptDelivery = Effect.fnUntraced(function* (message: Message) {
  const store = yield* DeliveryStore;
  const provider = yield* NotificationProvider;
  const { deliveryId } = yield* decodeMessage(message.body);
  const now = yield* Clock.currentTimeMillis;
  const started = yield* store.start(deliveryId, {
    now,
    until: now + attemptLeaseMillis,
    maxAttempts: maxDeliveryAttempts,
  });
  // Finished, waiting for a retry, or running elsewhere: the cron publishes it
  // again once an attempt may start.
  if (Option.isNone(started)) return;

  const attempt = started.value;
  const outcome = yield* provider
    .send({
      deliveryId,
      createdAt: attempt.createdAt,
      target: attempt.target,
      submission: attempt.submission,
      fields: attempt.fields,
    })
    .pipe(
      Effect.timeoutOrElse({ duration: providerTimeout, orElse: () => Effect.fail(timedOut()) }),
      Effect.match({
        onSuccess: (): typeof AttemptOutcome.Type => ({ _tag: "Delivered" }),
        onFailure: outcomeOf,
      }),
    );
  const finishedAt = yield* Clock.currentTimeMillis;
  const transition = afterAttempt(attempt.seriesAttempt, outcome, finishedAt);
  yield* store.finish(attempt, outcome, transition, finishedAt);
  yield* Effect.logInfo("Delivery attempt finished", {
    deliveryId,
    attempt: attempt.attempt,
    targetId: attempt.target.id,
    durationMs: finishedAt - now,
    outcome: outcome._tag,
    status: transition._tag,
  });
});

export const consumeDeliveries = Effect.fn("Deliveries.consume")(function* (batch: MessageBatch) {
  // Each message is one delivery: a slow or failing target does not hold the others.
  yield* Effect.forEach(
    batch.messages,
    (message) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(attemptDelivery(message));
        if (result._tag === "Success") {
          message.ack();
        } else {
          yield* Effect.logWarning("Delivery queue message requires retry", {
            tag: result.failure._tag,
          });
          message.retry();
        }
      }),
    { concurrency: "unbounded", discard: true },
  );
});
