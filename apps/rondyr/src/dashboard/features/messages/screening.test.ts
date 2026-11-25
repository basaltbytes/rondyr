import { assert, it } from "@effect/vitest";
import { Schema } from "effect";
import { createInstance } from "i18next";

import { SubmissionDetail } from "@rondyr/contracts/inbox";
import { ScreeningPreview } from "@rondyr/contracts/verification";

import { formats } from "~/lib/format";
import en from "~/locales/en/translation.json";

import { screeningOf, testOutcomeOf } from "./screening.ts";

const i18n = createInstance();
void i18n.init({
  lng: "en",
  resources: { en: { translation: en } },
  initAsync: false,
  interpolation: { escapeValue: false },
});
const { t } = i18n;
const format = formats.en;

type MessageEncoded = typeof SubmissionDetail.Encoded;
type VerificationEncoded = MessageEncoded["verification"];
type IntakeEncoded = NonNullable<VerificationEncoded["intake"]>;

const jev = {
  thresholds: { probableSpam: 0.7, ambiguous: 0.3, solicitation: 0.5, lowRelevance: 0.5 },
  offTopic: "review",
} as const;

const intake = {
  channel: "public",
  origin: { _tag: "Passed", mode: "listed", hasOrigin: true },
  honeypot: { _tag: "Passed", field: "website" },
  turnstile: { _tag: "NotConfigured" },
  repetition: {
    outcome: "passed",
    priorSameSender: 0,
    priorSameContent: 0,
    senderThreshold: 3,
    contentThreshold: 2,
    windowDays: 30,
  },
  blockedTerm: { _tag: "Passed" },
  quota: { _tag: "Passed", used: 41, limit: 200 },
  decisiveReason: null,
} as const satisfies IntakeEncoded;

const message = (
  row: Partial<Omit<MessageEncoded, "verification">>,
  verification: Partial<VerificationEncoded> = {},
) =>
  Schema.decodeSync(SubmissionDetail)({
    submissionId: "c70c35db-6727-456f-8b80-c344985e4440",
    organizationId: "organization",
    formId: "form",
    formPublicId: "contact",
    formName: "Contact",
    receivedAt: 1_795_000_000_000,
    status: "quarantined",
    reason: null,
    label: null,
    fields: { message: "Hello" },
    ...row,
    verification: {
      intake,
      intakeReason: null,
      priorSameSender: 0,
      priorSameContent: 0,
      intakeTraceId: null,
      outbox: null,
      events: [],
      ...verification,
    },
  });

const preview = (fields: Partial<typeof ScreeningPreview.Encoded>) =>
  Schema.decodeSync(ScreeningPreview)({
    outcome: "accepted",
    reason: null,
    label: null,
    blockedTerm: { _tag: "Passed" },
    rulesVersion: 7,
    traceId: null,
    evaluatedAt: 1_795_000_100_000,
    ...fields,
  });

const repeated = message(
  { reason: "repetition" },
  {
    intake: {
      ...intake,
      repetition: {
        ...intake.repetition,
        outcome: "failed",
        priorSameSender: 4,
        priorSameContent: 2,
      },
      quota: { _tag: "Skipped", reason: "quarantined-earlier" },
      decisiveReason: "repetition",
    },
    intakeReason: "repetition",
  },
);

const flaggedByAi = message(
  { reason: "probable-spam" },
  {
    events: [
      { seq: 1, occurredAt: 1_795_000_001_000, detail: { _tag: "ClassificationRequested" } },
      {
        seq: 2,
        occurredAt: 1_795_000_004_000,
        detail: {
          _tag: "SubmissionQuarantined",
          reason: "probable-spam",
          rulesVersion: 7,
          classifier: "jev",
          scores: { model: "jev", spam: 0.78, solicitation: 0.97, relevance: 0.36 },
          policy: jev,
        },
      },
    ],
  },
);

it("names the repetition that set a message aside at reception, and skips the AI rules", () => {
  const screening = screeningOf(t, format, repeated, repeated);

  assert.strictEqual(screening.verdict.kind, "content");
  assert.strictEqual(screening.verdict.tone, "flagged");
  assert.deepStrictEqual(
    screening.intake.filter((check) => check.state === "fired").map((check) => check.kind),
    ["sender", "content"],
  );
  assert.strictEqual(screening.intake.find((check) => check.kind === "quota")?.state, "off");
  assert.strictEqual(screening.aiMissing, "skipped");
  assert.deepStrictEqual(screening.ai, []);
});

it("keeps the repetition counts of a message received before the checks were recorded", () => {
  const legacy = message({ reason: "probable-spam" }, { intake: null, priorSameContent: 1 });

  const screening = screeningOf(t, format, legacy, legacy);

  assert.deepStrictEqual(
    screening.intake.map((check) => check.state),
    ["unknown", "unknown", "unknown", "passed", "passed", "unknown", "unknown"],
  );
  assert.deepStrictEqual(screening.intake.find((check) => check.kind === "content")?.count, {
    value: 1,
    threshold: 2,
  });
  assert.strictEqual(screening.aiMissing, "unrecorded");
});

it("places each AI score on the scale of its rule, with the zone that sets a message aside", () => {
  const screening = screeningOf(t, format, flaggedByAi, flaggedByAi);
  const [spam, solicitation, relevance] = screening.ai;

  assert.strictEqual(screening.verdict.kind, "spam");
  assert.deepStrictEqual(spam?.scale?.ticks, [0.3, 0.7]);
  assert.strictEqual(spam?.state, "fired");
  assert.deepStrictEqual(solicitation?.scale?.zones, [{ from: 0.5, to: 1, strong: true }]);
  assert.deepStrictEqual(relevance?.scale?.zones, [{ from: 0, to: 0.5, strong: true }]);
  assert.strictEqual(relevance?.state, "fired");
});

it("shows a classifier that failed as a check that could not finish", () => {
  const failed = message(
    { reason: "classification-error" },
    {
      events: [
        {
          seq: 1,
          occurredAt: 1_795_000_004_000,
          detail: {
            _tag: "SubmissionQuarantined",
            reason: "classification-error",
            rulesVersion: 7,
            classifier: "jev",
            failure: { kind: "timeout", retryable: true, attempts: 3 },
          },
        },
      ],
    },
  );

  const screening = screeningOf(t, format, failed, failed);

  assert.strictEqual(screening.verdict.tone, "error");
  assert.deepStrictEqual(
    screening.ai.map((check) => [check.kind, check.state]),
    [["classifier", "error"]],
  );
});

it("says that a test of the current rules would move a message set aside at reception", () => {
  const outcome = testOutcomeOf(
    t,
    format,
    repeated,
    preview({
      classifier: "jev",
      policy: jev,
      scores: { model: "jev", spam: 0.12, solicitation: 0.08, relevance: 0.81 },
    }),
  );

  assert.strictEqual(outcome.tone, "accepted");
  assert.isTrue(outcome.changed);
  assert.strictEqual(outcome.notes.length, 2);
  assert.strictEqual(outcome.ai.length, 3);
});

it("says that a test which sets the message aside again leaves it where it is", () => {
  const outcome = testOutcomeOf(
    t,
    format,
    flaggedByAi,
    preview({
      outcome: "quarantined",
      reason: "probable-spam",
      classifier: "jev",
      policy: jev,
      scores: { model: "jev", spam: 0.8, solicitation: 0.95, relevance: 0.3 },
    }),
  );

  assert.strictEqual(outcome.tone, "flagged");
  assert.isFalse(outcome.changed);
  assert.strictEqual(outcome.notes.length, 1);
});
