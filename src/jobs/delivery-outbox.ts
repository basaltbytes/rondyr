import { Clock, Context, Effect } from "effect";

import type { DeliveryId } from "../domain/deliveries/delivery.ts";
import {
  DeliveriesUnavailable,
  DeliveryScheduler,
} from "../domain/submissions/delivery-scheduler.external.ts";
import type { SubmissionId } from "../domain/submissions/submission.id.ts";
import { DeliveryQueue } from "../ports/delivery-queue.ts";
import { DeliveryStore } from "../ports/delivery-store.ts";
import type { OutboxLease } from "../ports/outbox.ts";

// Publication follows the submission outbox: a one-minute claim, and a published
// delivery that no attempt has taken after five minutes is published again.
const leaseFor = (now: number): OutboxLease => ({
  now,
  until: now + 60_000,
  republishBefore: now - 300_000,
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
            Effect.logWarning("Direct delivery publication failed", { tag: error._tag }),
          ),
          Effect.ignore,
        );
      }),
    };
  }),
);
