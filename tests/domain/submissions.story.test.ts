import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ApproveSubmission } from "../../src/domain/submissions/approve-submission.command.ts";
import { reviewReason, rulesVersion } from "../../src/domain/submissions/classification.ts";
import {
  ClassificationFailed,
  Classifier,
} from "../../src/domain/submissions/classifier.external.ts";
import { DismissSubmission } from "../../src/domain/submissions/dismiss-submission.command.ts";
import { InboxStore } from "../../src/domain/submissions/inbox-store.ts";
import { ListSubmissions } from "../../src/domain/submissions/list-submissions.query.ts";
import { SubmissionQuarantined } from "../../src/domain/submissions/record-classification.command.ts";
import {
  ClassificationRequested,
  RequestClassification,
} from "../../src/domain/submissions/request-classification.command.ts";
import { CurrentReviewer } from "../../src/domain/submissions/review-session.middleware.ts";
import { SubmissionAccepted } from "../../src/domain/submissions/submission-accepted.event.ts";
import { Submission } from "../../src/domain/submissions/submission.aggregate.ts";
import {
  OrganizationId,
  SubmissionId,
  UserId,
} from "../../src/domain/submissions/submission.id.ts";
import {
  SubmissionNotFound,
  SubmissionNotReviewable,
} from "../../src/domain/submissions/submission.rejection.ts";
import { Submissions, submissionHandlers } from "../../src/domain/submissions/submissions.model.ts";

const organizationId = OrganizationId.make("pottery");
const userId = UserId.make("reviewer");
const submissionId = SubmissionId.make("73123ee4-40bf-4c5f-b8ff-1d56cdaa7640");
const submission = Submission.ref(submissionId);

const store = Layer.succeed(InboxStore, {
  project: () => Effect.void,
  list: () => Effect.succeed({ entries: [], cursor: null }),
  detail: () => Effect.fail(SubmissionNotFound.make()),
});

const story = Story.make(Submissions, {
  layer: submissionHandlers.pipe(Layer.provide(store)),
  stub: [Classifier],
});

it("defines a valid Domain model and distinct classification thresholds", () => {
  assert.deepEqual(Domain.verify(Submissions), []);
  assert.strictEqual(reviewReason({ model: "jev-fixture", spam: 0.7 }), "probable-spam");
  assert.strictEqual(reviewReason({ model: "jev-fixture", spam: 0.3 }), "ambiguous");
  assert.strictEqual(
    reviewReason({ model: "jev-fixture", spam: 0.1, relevance: 0.1 }),
    "low-relevance",
  );
  assert.isNull(reviewReason({ model: "jev-fixture", spam: 0.1 }));
});

it.effect("classifies one logical submission after duplicate intake", () => {
  const scores = { model: "jev-fixture", spam: 0.1 };
  return story(
    Story.when(submission, RequestClassification.make({ organizationId }), {
      commandId: "ingestion-1",
    }),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    Story.call(Classifier.score, { submissionId, organizationId }),
    Story.succeed(Classifier.score, scores),
    Story.then(
      submission,
      SubmissionAccepted.make({
        organizationId,
        acceptance: { _tag: "Automatic", scores, rulesVersion },
      }),
    ),
    Story.when(submission, RequestClassification.make({ organizationId }), {
      commandId: "ingestion-1",
    }),
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission),
    Story.state(submission, { _tag: "Accepted" }),
  );
});

it.effect("quarantines exhausted failures and accepts only one authorized review", () =>
  story(
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    Story.call(Classifier.score, { submissionId, organizationId }),
    Story.fail(Classifier.score, ClassificationFailed.make({ retryable: true })),
    Story.advance("10 seconds"),
    Story.call(Classifier.score, { submissionId, organizationId }),
    Story.fail(Classifier.score, ClassificationFailed.make({ retryable: true })),
    Story.advance("30 seconds"),
    Story.call(Classifier.score, { submissionId, organizationId }),
    Story.fail(Classifier.score, ClassificationFailed.make({ retryable: true })),
    Story.then(
      submission,
      SubmissionQuarantined.make({ organizationId, reason: "classification-error", rulesVersion }),
    ),
    Story.provide(CurrentReviewer, { userId, organizations: [] }),
    Story.query(ListSubmissions, { organizationId }),
    Story.rejected(SubmissionNotFound.make()),
    Story.when(submission, DismissSubmission.make()),
    Story.rejected(SubmissionNotFound.make()),
    Story.provide(CurrentReviewer, { userId, organizations: [organizationId] }),
    Story.when(submission, ApproveSubmission.make()),
    Story.then(
      submission,
      SubmissionAccepted.make({
        organizationId,
        acceptance: { _tag: "Manual", reviewerId: userId },
      }),
    ),
    Story.when(submission, DismissSubmission.make()),
    Story.rejected(SubmissionNotReviewable.make()),
    Story.state(submission, { _tag: "Accepted" }),
  ),
);
