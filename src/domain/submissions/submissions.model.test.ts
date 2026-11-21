import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";

import { ApproveSubmission } from "./approve-submission.command.ts";
import {
  ClassificationThresholds,
  defaultClassificationPolicies,
  type ClassificationPolicy,
} from "./classification-policy.ts";
import {
  type ClassificationScores,
  classificationDecision,
  reviewReason,
  rulesVersion,
} from "./classification.ts";
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
import { ApiTokenId, OrganizationId, SubmissionId, UserId } from "./submission.id.ts";
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
    Effect.succeed({
      received: 0,
      classifying: 0,
      accepted: 0,
      quarantined: 0,
      archived: 0,
      forms: [],
    }),
  detail: () => Effect.fail(SubmissionNotFound.make()),
});

const story = Story.make(Submissions, {
  layer: submissionHandlers.pipe(Layer.provide(store)),
  stub: [Classifier, DeliveryScheduler],
});

const policy = defaultClassificationPolicies.jev;
const policyCall = () => Story.call(Classifier.policy, { organizationId });
const lookupPolicy = (resolved: ClassificationPolicy = policy) =>
  [
    policyCall(),
    Story.succeed(Classifier.policy, { classifier: "jev", policy: resolved }),
  ] as const;
const scoreCall = () =>
  Story.call(Classifier.score, { submissionId, organizationId, classifier: "jev" });
const secondScoreCall = () =>
  Story.call(Classifier.score, { submissionId, organizationId, classifier: "openai" });
const reservationCall = () => Story.call(Classifier.reserveEscalation, { organizationId });
const reserveEscalation = () =>
  [reservationCall(), Story.succeed(Classifier.reserveEscalation, "reserved")] as const;

it("defines a valid Domain model and distinct classification thresholds", () => {
  assert.deepEqual(Domain.verify(Submissions), []);
  const scores = { model: "jev-fixture", spam: 0.1, solicitation: 0 };
  assert.strictEqual(reviewReason({ ...scores, spam: 0.7 }, policy), "probable-spam");
  assert.strictEqual(reviewReason({ ...scores, spam: 0.3 }, policy), "ambiguous");
  assert.strictEqual(reviewReason({ ...scores, relevance: 0.1 }, policy), "low-relevance");
  assert.isNull(reviewReason(scores, policy));
});

it("quarantines for solicitation above 0.5, after the spam rules and before relevance", () => {
  const scores = { model: "jev-fixture", spam: 0.1, solicitation: 0.51, relevance: 0.1 };

  assert.strictEqual(reviewReason(scores, policy), "solicitation");
  assert.strictEqual(reviewReason({ ...scores, solicitation: 0.5 }, policy), "low-relevance");
  assert.strictEqual(reviewReason({ ...scores, spam: 0.3 }, policy), "ambiguous");
  assert.strictEqual(reviewReason({ ...scores, spam: 0.7 }, policy), "probable-spam");
  assert.isNull(reviewReason({ model: "jev-fixture", spam: 0.1, solicitation: 0.5 }, policy));
});

it.effect("decodes decisions recorded before policies and labels", () =>
  Effect.gen(function* () {
    const scores = { model: "jev-fixture", spam: 0.1, relevance: 0.2 };
    const acceptance = { _tag: "Automatic", scores, rulesVersion: 4 } as const;
    const quarantine = {
      organizationId,
      reason: "low-relevance",
      scores,
      rulesVersion: 4,
    } as const;
    const accepted = yield* Schema.decodeEffect(SubmissionAccepted)({
      _tag: "SubmissionAccepted",
      organizationId,
      acceptance,
    });
    const quarantined = yield* Schema.decodeEffect(SubmissionQuarantined)({
      _tag: "SubmissionQuarantined",
      ...quarantine,
    });
    assert.deepEqual(accepted.acceptance, acceptance);
    assert.deepInclude(quarantined, quarantine);
    assert.notProperty(quarantined, "policy");
  }),
);

it.effect(
  "uses the organization's thresholds and accepts a low-relevance message with a label",
  () => {
    const scores = { model: "jev-fixture", spam: 0.4, solicitation: 0.6, relevance: 0.3 };
    const custom: ClassificationPolicy = {
      thresholds: ClassificationThresholds.make({
        probableSpam: 0.9,
        ambiguous: 0.8,
        solicitation: 0.7,
        lowRelevance: 0.4,
      }),
      offTopic: "accept",
    };
    return story(
      Story.when(submission, RequestClassification.make({ organizationId })),
      Story.then(submission, ClassificationRequested.make({ organizationId })),
      ...lookupPolicy(custom),
      scoreCall(),
      Story.succeed(Classifier.score, scores),
      Story.then(
        submission,
        SubmissionAccepted.make({
          organizationId,
          acceptance: {
            _tag: "Automatic",
            scores,
            rulesVersion,
            policy: custom,
            label: "off-topic",
          },
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
  },
);

it.effect("quarantines when the organization's policy cannot be loaded", () =>
  story(
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    Story.call(Classifier.policy, { organizationId }),
    Story.fail(Classifier.policy, ClassificationFailed.make({ retryable: false })),
    Story.then(
      submission,
      SubmissionQuarantined.make({
        organizationId,
        reason: "classification-error",
        rulesVersion,
      }),
    ),
    Story.state(submission, { _tag: "Quarantined" }),
  ),
);

const ambiguousScores = { model: "jev-fixture", spam: 0.4, solicitation: 0.03 };
const escalationPolicy = { ...policy, escalation: true };
const clearedScores = { model: "openai-fixture", spam: 0.2, solicitation: 0.03, relevance: 0.9 };
const classifyAmbiguous = (
  chosenPolicy: ClassificationPolicy,
  firstScores: typeof ClassificationScores.Type = ambiguousScores,
) =>
  [
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    policyCall(),
    Story.succeed(Classifier.policy, {
      classifier: "jev",
      policy: chosenPolicy,
      escalationClassifier: "openai",
    }),
    scoreCall(),
    Story.succeed(Classifier.score, firstScores),
  ] as const;

it.effect("keeps an ambiguous submission in review when the organization disables escalation", () =>
  story(
    ...classifyAmbiguous(policy),
    Story.then(
      submission,
      SubmissionQuarantined.make({
        organizationId,
        reason: "ambiguous",
        scores: ambiguousScores,
        rulesVersion,
        policy,
      }),
    ),
    Story.state(submission, { _tag: "Quarantined" }),
  ),
);

it.effect("accepts and labels an ambiguous submission cleared by the second model", () => {
  const custom: ClassificationPolicy = {
    ...escalationPolicy,
    thresholds: ClassificationThresholds.make({
      ...escalationPolicy.thresholds,
      ambiguous: 0.1,
    }),
    offTopic: "accept",
  };
  const scores = { model: "openai-fixture", spam: 0.2, solicitation: 0.03, relevance: 0.3 };
  return story(
    ...classifyAmbiguous(custom),
    ...reserveEscalation(),
    secondScoreCall(),
    Story.succeed(Classifier.score, scores),
    Story.then(
      submission,
      SubmissionAccepted.make({
        organizationId,
        acceptance: {
          _tag: "Automatic",
          scores: ambiguousScores,
          rulesVersion,
          policy: custom,
          escalation: { classifier: "openai", scores, rulesVersion },
          label: "off-topic",
        },
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

it.effect("keeps the ambiguous reason when the second model also requires review", () => {
  const scores = { model: "openai-fixture", spam: 0.8, solicitation: 0.03 };
  return story(
    ...classifyAmbiguous(escalationPolicy),
    ...reserveEscalation(),
    secondScoreCall(),
    Story.succeed(Classifier.score, scores),
    Story.then(
      submission,
      SubmissionQuarantined.make({
        organizationId,
        reason: "ambiguous",
        scores: ambiguousScores,
        rulesVersion,
        policy: escalationPolicy,
        escalation: { classifier: "openai", scores, rulesVersion },
      }),
    ),
    Story.state(submission, { _tag: "Quarantined" }),
  );
});

for (const { finding, scores, reason } of [
  {
    finding: "a sales pitch",
    scores: { ...ambiguousScores, solicitation: 0.93, relevance: 0.9 },
    reason: "solicitation",
  },
  {
    finding: "an off-topic message",
    scores: { ...ambiguousScores, relevance: 0.1 },
    reason: "low-relevance",
  },
] as const) {
  it.effect(`keeps ${finding} in review when the second model clears the spam doubt`, () =>
    story(
      ...classifyAmbiguous(escalationPolicy, scores),
      ...reserveEscalation(),
      secondScoreCall(),
      Story.succeed(Classifier.score, clearedScores),
      Story.then(
        submission,
        SubmissionQuarantined.make({
          organizationId,
          reason,
          scores,
          rulesVersion,
          policy: escalationPolicy,
          escalation: { classifier: "openai", scores: clearedScores, rulesVersion },
        }),
      ),
      Story.state(submission, { _tag: "Quarantined" }),
    ),
  );
}

it("labels an escalated acceptance off-topic when either model finds it off-topic", () => {
  const accepting = { ...escalationPolicy, offTopic: "accept" } as const;
  const escalation = { classifier: "openai", scores: clearedScores } as const;
  const decide = (relevance: number) =>
    classificationDecision({ ...ambiguousScores, relevance }, accepting, escalation);
  // The second model finds the message relevant; the first model's relevance decides the label.
  assert.deepEqual(decide(0.1), { reason: null, label: "off-topic" });
  assert.deepEqual(decide(0.9), { reason: null });
});

it.effect(
  "reserves once and keeps the ambiguous reason after the second model exhausts its retries",
  () =>
    story(
      ...classifyAmbiguous(escalationPolicy),
      ...reserveEscalation(),
      secondScoreCall(),
      Story.fail(Classifier.score, ClassificationFailed.make({ retryable: true })),
      Story.advance("10 seconds"),
      secondScoreCall(),
      Story.fail(Classifier.score, ClassificationFailed.make({ retryable: true })),
      Story.advance("30 seconds"),
      secondScoreCall(),
      Story.fail(Classifier.score, ClassificationFailed.make({ retryable: true })),
      Story.then(
        submission,
        SubmissionQuarantined.make({
          organizationId,
          reason: "ambiguous",
          scores: ambiguousScores,
          rulesVersion,
          policy: escalationPolicy,
          escalation: { classifier: "openai", rulesVersion },
        }),
      ),
      Story.state(submission, { _tag: "Quarantined" }),
    ),
);

it.effect(
  "keeps the ambiguous reason without a second call at the daily classification limit",
  () =>
    story(
      ...classifyAmbiguous(escalationPolicy),
      reservationCall(),
      Story.succeed(Classifier.reserveEscalation, "limit-reached"),
      // No second score call: a story fails on any external call it does not expect.
      Story.then(
        submission,
        SubmissionQuarantined.make({
          organizationId,
          reason: "ambiguous",
          scores: ambiguousScores,
          rulesVersion,
          policy: escalationPolicy,
          escalation: { classifier: "openai", rulesVersion, skipped: "quota" },
        }),
      ),
      Story.state(submission, { _tag: "Quarantined" }),
    ),
);

it.effect(
  "keeps the ambiguous reason without a second call when the reservation keeps failing",
  () =>
    story(
      ...classifyAmbiguous(escalationPolicy),
      reservationCall(),
      Story.fail(Classifier.reserveEscalation, ClassificationFailed.make({ retryable: true })),
      Story.advance("10 seconds"),
      reservationCall(),
      Story.fail(Classifier.reserveEscalation, ClassificationFailed.make({ retryable: true })),
      Story.advance("30 seconds"),
      reservationCall(),
      Story.fail(Classifier.reserveEscalation, ClassificationFailed.make({ retryable: true })),
      Story.then(
        submission,
        SubmissionQuarantined.make({
          organizationId,
          reason: "ambiguous",
          scores: ambiguousScores,
          rulesVersion,
          policy: escalationPolicy,
          escalation: { classifier: "openai", rulesVersion },
        }),
      ),
      Story.state(submission, { _tag: "Quarantined" }),
    ),
);

it.effect("looks up the policy again 10 seconds after a retryable failure, then scores", () => {
  const scores = { model: "jev-fixture", spam: 0.1, solicitation: 0.15 };
  return story(
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    policyCall(),
    Story.fail(Classifier.policy, ClassificationFailed.make({ retryable: true })),
    Story.advance("10 seconds"),
    ...lookupPolicy(),
    scoreCall(),
    Story.succeed(Classifier.score, scores),
    Story.then(
      submission,
      SubmissionAccepted.make({
        organizationId,
        acceptance: { _tag: "Automatic", scores, rulesVersion, policy },
      }),
    ),
    Story.call(DeliveryScheduler.schedule, {
      submissionId,
      organizationId,
      acceptedAt: storyStart + 10_000,
    }),
    Story.succeed(DeliveryScheduler.schedule, undefined),
    Story.state(submission, { _tag: "Accepted" }),
  );
});

it.effect("quarantines after three retryable failures of the policy lookup", () =>
  story(
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    policyCall(),
    Story.fail(Classifier.policy, ClassificationFailed.make({ retryable: true })),
    Story.advance("10 seconds"),
    policyCall(),
    Story.fail(Classifier.policy, ClassificationFailed.make({ retryable: true })),
    Story.advance("30 seconds"),
    policyCall(),
    Story.fail(Classifier.policy, ClassificationFailed.make({ retryable: true })),
    Story.then(
      submission,
      SubmissionQuarantined.make({
        organizationId,
        reason: "classification-error",
        rulesVersion,
      }),
    ),
    Story.state(submission, { _tag: "Quarantined" }),
  ),
);

it.effect("quarantines a sales pitch with its scores and lets a reviewer accept it", () => {
  const scores = { model: "jev-fixture", spam: 0.1, solicitation: 0.93, relevance: 0.8 };
  return story(
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    ...lookupPolicy(),
    scoreCall(),
    Story.succeed(Classifier.score, scores),
    Story.then(
      submission,
      SubmissionQuarantined.make({
        organizationId,
        reason: "solicitation",
        scores,
        rulesVersion,
        policy,
      }),
    ),
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
  );
});

it.effect("classifies one logical submission after duplicate intake", () => {
  const scores = { model: "jev-fixture", spam: 0.1, solicitation: 0.15 };
  return story(
    Story.when(submission, RequestClassification.make({ organizationId }), {
      commandId: "ingestion-1",
    }),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    ...lookupPolicy(),
    scoreCall(),
    Story.succeed(Classifier.score, scores),
    Story.then(
      submission,
      SubmissionAccepted.make({
        organizationId,
        acceptance: { _tag: "Automatic", scores, rulesVersion, policy },
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
    ...lookupPolicy(),
    scoreCall(),
    Story.fail(Classifier.score, ClassificationFailed.make({ retryable: false })),
    Story.then(
      submission,
      SubmissionQuarantined.make({
        organizationId,
        reason: "classification-error",
        rulesVersion,
        policy,
      }),
    ),
    Story.state(submission, { _tag: "Quarantined" }),
  ),
);

it.effect("quarantines exhausted failures and accepts only one authorized review", () =>
  story(
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    ...lookupPolicy(),
    scoreCall(),
    Story.fail(Classifier.score, ClassificationFailed.make({ retryable: true })),
    Story.advance("10 seconds"),
    scoreCall(),
    Story.fail(Classifier.score, ClassificationFailed.make({ retryable: true })),
    Story.advance("30 seconds"),
    scoreCall(),
    Story.fail(Classifier.score, ClassificationFailed.make({ retryable: true })),
    Story.then(
      submission,
      SubmissionQuarantined.make({
        organizationId,
        reason: "classification-error",
        rulesVersion,
        policy,
      }),
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

it.effect("records the token that accepts a quarantined submission", () => {
  const apiTokenId = ApiTokenId.make("site-inbox-token");
  return story(
    Story.when(submission, QuarantineAtIntake.make({ organizationId, reason: "honeypot" })),
    Story.then(
      submission,
      SubmissionQuarantined.make({ organizationId, reason: "honeypot", rulesVersion }),
    ),
    Story.provide(CurrentReviewer, { apiTokenId, organizations: [organizationId] }),
    Story.when(submission, ApproveSubmission.make()),
    Story.then(
      submission,
      SubmissionAccepted.make({ organizationId, acceptance: { _tag: "Manual", apiTokenId } }),
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

it.effect("records the token that archives a quarantined submission", () => {
  const apiTokenId = ApiTokenId.make("site-inbox-token");
  return story(
    Story.when(submission, QuarantineAtIntake.make({ organizationId, reason: "honeypot" })),
    Story.then(
      submission,
      SubmissionQuarantined.make({ organizationId, reason: "honeypot", rulesVersion }),
    ),
    Story.provide(CurrentReviewer, { apiTokenId, organizations: [organizationId] }),
    Story.when(submission, DismissSubmission.make()),
    Story.then(submission, SubmissionDismissed.make({ organizationId, apiTokenId })),
    Story.state(submission, { _tag: "Archived" }),
  );
});

it.effect("ignores a quarantine at intake once classification has started", () => {
  const scores = { model: "jev-fixture", spam: 0.1, solicitation: 0 };
  return story(
    Story.when(submission, RequestClassification.make({ organizationId })),
    Story.then(submission, ClassificationRequested.make({ organizationId })),
    ...lookupPolicy(),
    scoreCall(),
    Story.when(submission, QuarantineAtIntake.make({ organizationId, reason: "honeypot" })),
    Story.then(submission),
    Story.succeed(Classifier.score, scores),
    Story.then(
      submission,
      SubmissionAccepted.make({
        organizationId,
        acceptance: { _tag: "Automatic", scores, rulesVersion, policy },
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
