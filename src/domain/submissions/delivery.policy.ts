import * as Domain from "@alchemy.run/domain";
import { DateTime, Effect } from "effect";

import { DeliveryScheduler } from "./delivery-scheduler.external.ts";
import { SubmissionAccepted } from "./submission-accepted.event.ts";
import { Submission } from "./submission.aggregate.ts";

// A policy acts on new events only: a deploy never replays past acceptances into it.
export class Delivery extends Domain.Policy(
  "Delivery",
  { from: Submission, on: [SubmissionAccepted] },
  { description: "Schedule the deliveries of a submission once it is accepted." },
) {}

export const deliveryLive = Delivery.toLayer(
  Effect.gen(function* () {
    const scheduler = yield* DeliveryScheduler;
    return Effect.fnUntraced(function* ({ source, event, envelope }) {
      // A failed run is retried by the platform, so an outage delays deliveries
      // instead of dropping them. Scheduling twice creates nothing new.
      yield* scheduler
        .schedule({
          submissionId: source.id,
          organizationId: event.organizationId,
          acceptedAt: DateTime.toEpochMillis(envelope.at),
        })
        .pipe(Effect.orDie);
    });
  }),
);
