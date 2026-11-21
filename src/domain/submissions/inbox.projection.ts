import * as Domain from "@alchemy.run/domain";
import { Effect } from "effect";

import { SubmissionDismissed } from "./dismiss-submission.command.ts";
import { InboxStore } from "./inbox-store.ts";
import { SubmissionQuarantined } from "./submission-quarantined.event.ts";
import { ClassificationRequested } from "./request-classification.command.ts";
import { SubmissionAccepted } from "./submission-accepted.event.ts";
import { Submission } from "./submission.aggregate.ts";

export class Inbox extends Domain.Projection(
  "Inbox",
  {
    from: [Submission],
    key: Submission,
    on: [ClassificationRequested, SubmissionQuarantined, SubmissionAccepted, SubmissionDismissed],
  },
  { description: "Project the latest submission status into the organization inbox." },
) {}

const statuses = {
  ClassificationRequested: "classifying",
  SubmissionQuarantined: "quarantined",
  SubmissionAccepted: "accepted",
  SubmissionDismissed: "archived",
} as const;

export const inboxLive = Inbox.toLayer(
  Effect.gen(function* () {
    const store = yield* InboxStore;
    return Effect.fnUntraced(function* (batch) {
      for (const { source, event, envelope } of batch) {
        yield* store
          .project({
            submissionId: source.id,
            version: envelope.seq,
            status: statuses[event._tag],
            reason: event._tag === "SubmissionQuarantined" ? event.reason : null,
            label:
              event._tag === "SubmissionAccepted" && event.acceptance._tag === "Automatic"
                ? (event.acceptance.label ?? null)
                : null,
          })
          .pipe(Effect.orDie);
      }
    });
  }),
);
