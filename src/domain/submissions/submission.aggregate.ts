import * as Domain from "@alchemy.run/domain";
import { Effect, Schema } from "effect";

import { ApproveSubmission } from "./approve-submission.command.ts";
import { classificationDecision, rulesVersion } from "./classification.ts";
import { DismissSubmission, SubmissionDismissed } from "./dismiss-submission.command.ts";
import { QuarantineAtIntake } from "./quarantine-at-intake.command.ts";
import { RecordClassification } from "./record-classification.command.ts";
import {
  RequestClassification,
  ClassificationRequested,
} from "./request-classification.command.ts";
import { CurrentReviewer } from "./review-session.middleware.ts";
import { SubmissionAccepted } from "./submission-accepted.event.ts";
import { SubmissionQuarantined } from "./submission-quarantined.event.ts";
import { SubmissionNotFound, SubmissionNotReviewable } from "./submission.rejection.ts";
import { OrganizationId, SubmissionId } from "./submission.id.ts";

const owner = { organizationId: OrganizationId };
const State = Schema.Union([
  Schema.TaggedStruct("Unrecorded", {}),
  Schema.TaggedStruct("Classifying", owner),
  Schema.TaggedStruct("Quarantined", owner),
  Schema.TaggedStruct("Accepted", owner),
  Schema.TaggedStruct("Archived", owner),
]);

const review = Effect.fnUntraced(function* (state: typeof State.Type) {
  const reviewer = yield* CurrentReviewer;
  if (state._tag === "Unrecorded" || !reviewer.organizations.includes(state.organizationId)) {
    return yield* SubmissionNotFound.make();
  }
  if (state._tag !== "Quarantined") return yield* SubmissionNotReviewable.make();
  return {
    organizationId: state.organizationId,
    author:
      reviewer.apiTokenId === undefined
        ? { reviewerId: reviewer.userId }
        : { apiTokenId: reviewer.apiTokenId },
  };
});

export class Submission extends Domain.Aggregate(
  "Submission",
  {
    id: SubmissionId,
    state: State,
    initial: { _tag: "Unrecorded" },
    commands: [
      RequestClassification,
      QuarantineAtIntake,
      RecordClassification,
      ApproveSubmission,
      DismissSubmission,
    ],
    decide: {
      // The hand-off of a received submission is either a classification request or
      // a quarantine at intake. Only the first one that reaches the submission counts.
      RequestClassification: (state, { organizationId }) =>
        state._tag === "Unrecorded" ? [ClassificationRequested.make({ organizationId })] : [],
      QuarantineAtIntake: (state, { organizationId, reason }) =>
        state._tag === "Unrecorded"
          ? [SubmissionQuarantined.make({ organizationId, reason, rulesVersion })]
          : [],
      RecordClassification: (state, { result }) => {
        if (state._tag !== "Classifying") return [];
        const { organizationId } = state;
        if (result._tag === "ClassificationError") {
          const failure = { organizationId, reason: "classification-error", rulesVersion } as const;
          if (result.policy === undefined) return [SubmissionQuarantined.make(failure)];
          return [SubmissionQuarantined.make({ ...failure, policy: result.policy })];
        }
        const { scores, policy, escalation } = result;
        const decision = classificationDecision(scores, policy, escalation);
        const evaluation = { scores, rulesVersion, policy, ...(escalation && { escalation }) };
        if (decision.reason !== null) {
          return [
            SubmissionQuarantined.make({
              organizationId,
              reason: decision.reason,
              ...evaluation,
            }),
          ];
        }
        return [
          SubmissionAccepted.make({
            organizationId,
            acceptance: {
              _tag: "Automatic",
              ...evaluation,
              ...(decision.label && { label: decision.label }),
            },
          }),
        ];
      },
      ApproveSubmission: Effect.fnUntraced(function* (state) {
        const { organizationId, author } = yield* review(state);
        return [
          SubmissionAccepted.make({ organizationId, acceptance: { _tag: "Manual", ...author } }),
        ];
      }),
      DismissSubmission: Effect.fnUntraced(function* (state) {
        const { organizationId, author } = yield* review(state);
        return [SubmissionDismissed.make({ organizationId, ...author })];
      }),
    },
    evolve: {
      ClassificationRequested: (state, { organizationId }) =>
        state._tag === "Unrecorded" ? { _tag: "Classifying" as const, organizationId } : state,
      SubmissionQuarantined: (state, { organizationId }) =>
        state._tag === "Unrecorded" || state._tag === "Classifying"
          ? { _tag: "Quarantined" as const, organizationId }
          : state,
      SubmissionAccepted: (state, { organizationId }) =>
        state._tag === "Classifying" || state._tag === "Quarantined"
          ? { _tag: "Accepted" as const, organizationId }
          : state,
      SubmissionDismissed: (state, { organizationId }) =>
        state._tag === "Quarantined" ? { _tag: "Archived" as const, organizationId } : state,
    },
  },
  {
    description:
      "Decide whether one durably received submission is accepted or needs human review.",
  },
) {}
