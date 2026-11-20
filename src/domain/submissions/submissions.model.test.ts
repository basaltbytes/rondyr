import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ApproveSubmission } from "./approve-submission.command.ts";
import { classificationThresholds, reviewReason, rulesVersion } from "./classification.ts";
import { ClassificationFailed, Classifier } from "./classifier.external.ts";
import { DeliveryScheduler } from "./delivery-scheduler.external.ts";
import { DismissSubmission, SubmissionDismissed } from "./dismiss-submission.command.ts";
import { InboxStore } from "./inbox-store.ts";
import { ListSubmissions } from "./list-submissions.query.ts";
import { QuarantineAtIntake } from "./quarantine-at-intake.command.ts";
import {
  ClassificationRequested,
  RequestClassification,
} from "./request-classification.command.ts";
import { CurrentReviewer } from "./review-session.middleware.ts";
import { SubmissionAccepted } from "./submission-accepted.event.ts";
import { SubmissionQuarantined } from "./submission-quarantined.event.ts";
import { Submission } from "./submission.aggregate.ts";
import { OrganizationId, SubmissionId, UserId } from "./submission.id.ts";
import { SubmissionNotFound, SubmissionNotReviewable } from "./submission.rejection.ts";
import { Submissions, submissionHandlers } from "./submissions.model.ts";

const organizationId = OrganizationId.make("pottery");
const userId = UserId.make("reviewer");
const submissionId = SubmissionId.make("73123ee4-40bf-4c5f-b8ff-1d56cdaa7640");
const submission = Submission.ref(submissionId);
// A story's clock starts on 1 January 2026.
const storyStart = 1_767_225_600_000;

const store = Layer.succeed(InboxStore, {
  project: () => Effect.void,
  list: () => Effect.succeed({ entries: [], cursor: null }),
  counts: () =>
    Effect.succeed({ received: 0, classifying: 0, accepted: 0, quarantined: 0, archived: 0 }),
  detail: () => Effect.fail(SubmissionNotFound.make()),
});

const story = Story.make(Submissions, {
  layer: submissionHandlers.pipe(Layer.provide(store)),
  stub: [Classifier, DeliveryScheduler],
});

it("defines a valid Domain model and distinct classification thresholds", () => {
  assert.deepEqual(Domain.verify(Submissions), []);
  const scores = { model: "jev-fixture", spam: 0.1, solicitation: 0 };
  assert.strictEqual(reviewReason({ ...scores, spam: 0.7 }), "probable-spam");
  assert.strictEqual(reviewReason({ ...scores, spam: 0.3 }), "ambiguous");
  assert.strictEqual(reviewReason({ ...scores, relevance: 0.1 }), "low-relevance");
  assert.isNull(reviewReason(scores));
});

it("quarantines for solicitation above the threshold after spam and before relevance", () => {
  const thresholds = { ...classificationThresholds, solicitation: 0.8 };
  const scores = { model: "jev-fixture", spam: 0.1, solicitation: 0.81, relevance: 0.1 };

  assert.strictEqual(reviewReason(scores, thresholds), "solicitation");
  assert.strictEqual(reviewReason({ ...scores, solicitation: 0.8 }, thresholds), "low-relevance");
  assert.strictEqual(reviewReason({ ...scores, spam: 0.3 }, thresholds), "ambiguous");
  assert.strictEqual(reviewReason({ ...scores, spam: 0.7 }, thresholds), "probable-spam");
});

it.effect("classifies one logical submission after duplicate intake", () => {
  const scores = { model: "jev-fixture", spam: 0.1, solicitation: 0.15 };
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
    Story.call(DeliveryScheduler.schedule, {
      submissionId,
      organizationId,
      acceptedAt: storyStart,
    }),
    Story.succeed(DeliveryScheduler.schedule, undefined),
    Story.when(submission, RequestClassification.make({ organizationId }), {
      commandId: "ingestion-1",
    }),
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission),
    Story.state(submission, { _tag: "Accepted" }),
  );
});

it.effect("quarantines an incomplete classifier response without retrying", () =>
  story(
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    Story.call(Classifier.score, { submissionId, organizationId }),
    Story.fail(Classifier.score, ClassificationFailed.make({ retryable: false })),
    Story.then(
      submission,
      SubmissionQuarantined.make({ organizationId, reason: "classification-error", rulesVersion }),
    ),
    Story.state(submission, { _tag: "Quarantined" }),
  ),
);

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
    Story.call(DeliveryScheduler.schedule, {
      submissionId,
      organizationId,
      acceptedAt: storyStart + 40_000,
    }),
    Story.succeed(DeliveryScheduler.schedule, undefined),
    Story.when(submission, DismissSubmission.make()),
    Story.rejected(SubmissionNotReviewable.make()),
    Story.state(submission, { _tag: "Accepted" }),
  ),
);

it.effect("quarantines a submission at intake without the classifier, once", () =>
  story(
    Story.when(submission, QuarantineAtIntake.make({ organizationId, reason: "honeypot" }), {
      commandId: "ingestion-1",
    }),
    // No classifier call: a story fails on any external call it does not expect.
    Story.then(
      submission,
      SubmissionQuarantined.make({ organizationId, reason: "honeypot", rulesVersion }),
    ),
    // A redelivered hand-off, with the same command ID or another one, records nothing.
    Story.when(submission, QuarantineAtIntake.make({ organizationId, reason: "honeypot" }), {
      commandId: "ingestion-1",
    }),
    Story.when(submission, QuarantineAtIntake.make({ organizationId, reason: "honeypot" })),
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission),
    Story.state(submission, { _tag: "Quarantined" }),
    Story.provide(CurrentReviewer, { userId, organizations: [organizationId] }),
    Story.when(submission, ApproveSubmission.make()),
    Story.then(
      submission,
      SubmissionAccepted.make({
        organizationId,
        acceptance: { _tag: "Manual", reviewerId: userId },
      }),
    ),
    Story.call(DeliveryScheduler.schedule, {
      submissionId,
      organizationId,
      acceptedAt: storyStart,
    }),
    Story.succeed(DeliveryScheduler.schedule, undefined),
    Story.state(submission, { _tag: "Accepted" }),
  ),
);

it.effect("lets a reviewer dismiss a submission quarantined at intake", () =>
  story(
    Story.when(submission, QuarantineAtIntake.make({ organizationId, reason: "honeypot" })),
    Story.then(
      submission,
      SubmissionQuarantined.make({ organizationId, reason: "honeypot", rulesVersion }),
    ),
    Story.provide(CurrentReviewer, { userId, organizations: [organizationId] }),
    Story.when(submission, DismissSubmission.make()),
    Story.then(submission, SubmissionDismissed.make({ organizationId, reviewerId: userId })),
    Story.state(submission, { _tag: "Archived" }),
  ),
);

it.effect("ignores a quarantine at intake once classification has started", () => {
  const scores = { model: "jev-fixture", spam: 0.1, solicitation: 0 };
  return story(
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    Story.call(Classifier.score, { submissionId, organizationId }),
    Story.when(submission, QuarantineAtIntake.make({ organizationId, reason: "honeypot" })),
    Story.then(submission),
    Story.succeed(Classifier.score, scores),
    Story.then(
      submission,
      SubmissionAccepted.make({
        organizationId,
        acceptance: { _tag: "Automatic", scores, rulesVersion },
      }),
    ),
    Story.call(DeliveryScheduler.schedule, {
      submissionId,
      organizationId,
      acceptedAt: storyStart,
    }),
    Story.succeed(DeliveryScheduler.schedule, undefined),
    Story.state(submission, { _tag: "Accepted" }),
  );
});
