import * as Domain from "@alchemy.run/domain";
import { DateTime, Effect } from "effect";

import { SubmissionDismissed } from "./dismiss-submission.command.ts";
import { InboxStore } from "./inbox-store.ts";
import { ReclassificationRequested } from "./reclassify-submission.command.ts";
import { SubmissionQuarantined } from "./submission-quarantined.event.ts";
import { ClassificationRequested } from "./request-classification.command.ts";
import { SubmissionAccepted } from "./submission-accepted.event.ts";
import { Submission } from "./submission.aggregate.ts";
import type { EventActor, SubmissionEventDetail } from "./verification.ts";

export class Inbox extends Domain.Projection(
  "Inbox",
  {
    from: [Submission],
    key: Submission,
    on: [
      ClassificationRequested,
      ReclassificationRequested,
      SubmissionQuarantined,
      SubmissionAccepted,
      SubmissionDismissed,
    ],
  },
  { description: "Project the latest submission status into the organization inbox." },
) {}

const statuses = {
  ClassificationRequested: "classifying",
  ReclassificationRequested: "classifying",
  SubmissionQuarantined: "quarantined",
  SubmissionAccepted: "accepted",
  SubmissionDismissed: "archived",
} as const;

function actorOf(author: {
  readonly reviewerId?: typeof SubmissionDismissed.Type.reviewerId;
  readonly apiTokenId?: typeof SubmissionDismissed.Type.apiTokenId;
}): EventActor | undefined {
  if (author.reviewerId !== undefined) {
    return { _tag: "Reviewer", userId: author.reviewerId, name: null };
  }
  if (author.apiTokenId !== undefined) {
    return { _tag: "ApiToken", apiTokenId: author.apiTokenId, name: null, suffix: null };
  }
  return undefined;
}

function eventDetail(
  event:
    | ClassificationRequested
    | ReclassificationRequested
    | SubmissionQuarantined
    | SubmissionAccepted
    | SubmissionDismissed,
): SubmissionEventDetail {
  switch (event._tag) {
    case "ClassificationRequested":
      return { _tag: "ClassificationRequested" };
    case "ReclassificationRequested": {
      const actor = actorOf(event);
      return actor === undefined
        ? { _tag: "ReclassificationRequested" }
        : { _tag: "ReclassificationRequested", actor };
    }
    case "SubmissionQuarantined":
      return {
        _tag: "SubmissionQuarantined",
        reason: event.reason,
        rulesVersion: event.rulesVersion,
        ...(event.classifier !== undefined && { classifier: event.classifier }),
        ...(event.scores !== undefined && { scores: event.scores }),
        ...(event.signals !== undefined && { signals: event.signals }),
        ...(event.policy !== undefined && { policy: event.policy }),
        ...(event.escalation !== undefined && { escalation: event.escalation }),
        ...(event.attempts !== undefined && { attempts: event.attempts }),
        ...(event.failure !== undefined && { failure: event.failure }),
      };
    case "SubmissionAccepted":
      if (event.acceptance._tag === "Automatic") {
        const { classifier, scores, signals, rulesVersion, policy, escalation, attempts, label } =
          event.acceptance;
        return {
          _tag: "SubmissionAccepted",
          mode: "automatic",
          rulesVersion,
          scores,
          ...(classifier !== undefined && { classifier }),
          ...(signals !== undefined && { signals }),
          ...(policy !== undefined && { policy }),
          ...(escalation !== undefined && { escalation }),
          ...(attempts !== undefined && { attempts }),
          ...(label !== undefined && { label }),
        };
      }
      {
        const actor = actorOf(event.acceptance);
        return {
          _tag: "SubmissionAccepted",
          mode: "manual",
          ...(actor !== undefined && { actor }),
        };
      }
    case "SubmissionDismissed": {
      const actor = actorOf(event);
      return actor === undefined
        ? { _tag: "SubmissionDismissed" }
        : { _tag: "SubmissionDismissed", actor };
    }
  }
}

export const inboxLive = Inbox.toLayer(
  Effect.gen(function* () {
    const store = yield* InboxStore;
    return Effect.fnUntraced(function* (batch) {
      for (const { source, event, envelope } of batch) {
        const status = statuses[event._tag];
        const reason = event._tag === "SubmissionQuarantined" ? event.reason : null;
        const label =
          event._tag === "SubmissionAccepted" && event.acceptance._tag === "Automatic"
            ? (event.acceptance.label ?? null)
            : null;
        const detail = eventDetail(event);
        yield* Effect.annotateCurrentSpan({
          submissionId: source.id,
          "inbox.event": event._tag,
          "inbox.seq": envelope.seq,
          "inbox.status": status,
          ...(reason !== null && { "inbox.reason": reason }),
        });
        yield* store
          .project({
            submissionId: source.id,
            version: envelope.seq,
            status,
            reason,
            label,
            event: {
              eventType: detail._tag,
              occurredAt: DateTime.toEpochMillis(envelope.at),
              detail,
            },
          })
          .pipe(Effect.orDie);
      }
    });
  }),
);
