import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Metric, Schema, Tracer } from "effect";

import {
  ClassificationThresholds,
  defaultClassificationPolicies,
  type ClassificationPolicy,
} from "./classification-policy.ts";
import {
  intakeChecksMetric,
  intakeSubmissionsMetric,
  recordMetric,
  screeningPreviewsMetric,
} from "./submission-metrics.ts";
import {
  evaluateClassificationChecks,
  IntakeVerification,
  ScreeningPreview,
  SubmissionVerification,
} from "./verification.ts";

const jevPolicy = defaultClassificationPolicies.jev;

describe("evaluateClassificationChecks", () => {
  it("marks all checks passed for a clean acceptance with business context", () => {
    const result = evaluateClassificationChecks(
      { model: "jev-v1", spam: 0.04, solicitation: 0.1, relevance: 0.92 },
      jevPolicy,
      "jev",
      undefined,
      null,
    );

    assert.strictEqual(result.spam.status, "passed");
    assert.strictEqual(result.spam.decisive, false);
    assert.isNull(result.escalation);
    assert.strictEqual(result.solicitation.status, "passed");
    assert.strictEqual(result.solicitation.decisive, false);
    assert.strictEqual(result.relevance.status, "passed");
    assert.strictEqual(result.relevance.decisive, false);
  });

  it("identifies probable spam as decisive when spam reaches the probable threshold", () => {
    const result = evaluateClassificationChecks(
      { model: "jev-v1", spam: 0.7, solicitation: 0.1, relevance: 0.9 },
      jevPolicy,
      "jev",
      undefined,
      "probable-spam",
    );

    assert.strictEqual(result.spam.status, "failed");
    assert.strictEqual(result.spam.decisive, true);
    assert.strictEqual(result.solicitation.status, "passed");
    assert.strictEqual(result.relevance.status, "passed");
  });

  it("marks spam as cleared when the second model clears an ambiguous score while solicitation fails", () => {
    const result = evaluateClassificationChecks(
      { model: "jev-v1", spam: 0.42, solicitation: 0.85, relevance: 0.9 },
      { ...jevPolicy, escalation: true },
      "jev",
      {
        classifier: "openai",
        rulesVersion: 7,
        scores: { model: "openai-v1", spam: 0.12, solicitation: 0.04, relevance: 0.91 },
        attempts: 1,
      },
      "solicitation",
    );

    assert.strictEqual(result.spam.status, "cleared");
    assert.strictEqual(result.spam.decisive, false);
    assert.strictEqual(result.escalation?.status, "cleared");
    assert.strictEqual(result.solicitation.status, "failed");
    assert.strictEqual(result.solicitation.decisive, true);
    assert.strictEqual(result.relevance.status, "passed");
  });

  it("reports confirmed escalation when the second model also flags the message", () => {
    const result = evaluateClassificationChecks(
      { model: "jev-v1", spam: 0.45, solicitation: 0.05 },
      { ...jevPolicy, escalation: true },
      "jev",
      {
        classifier: "openai",
        rulesVersion: 7,
        scores: { model: "openai-v1", spam: 0.82, solicitation: 0.05 },
        attempts: 1,
      },
      "ambiguous",
    );

    assert.strictEqual(result.spam.status, "ambiguous");
    assert.strictEqual(result.spam.decisive, true);
    assert.strictEqual(result.escalation?.status, "confirmed");
    if (result.escalation?.status === "confirmed") {
      assert.strictEqual(result.escalation.reason, "probable-spam");
    }
  });

  it("reports quota-skipped and failed escalations distinctly", () => {
    const skipped = evaluateClassificationChecks(
      { model: "jev-v1", spam: 0.45, solicitation: 0.05 },
      { ...jevPolicy, escalation: true },
      "jev",
      { classifier: "openai", rulesVersion: 7, skipped: "quota" },
      "ambiguous",
    );
    assert.strictEqual(skipped.escalation?.status, "skipped-quota");

    const failed = evaluateClassificationChecks(
      { model: "jev-v1", spam: 0.45, solicitation: 0.05 },
      { ...jevPolicy, escalation: true },
      "jev",
      {
        classifier: "openai",
        rulesVersion: 7,
        attempts: 3,
        failure: { kind: "timeout", retryable: true, attempts: 3 },
      },
      "ambiguous",
    );
    assert.strictEqual(failed.escalation?.status, "failed");
    if (failed.escalation?.status === "failed") {
      assert.strictEqual(failed.escalation.failure?.kind, "timeout");
      assert.strictEqual(failed.escalation.attempts, 3);
    }
  });

  it("distinguishes low-relevance quarantine from off-topic acceptance and unconfigured context", () => {
    const reviewPolicy: ClassificationPolicy = {
      thresholds: ClassificationThresholds.make({
        probableSpam: 0.7,
        ambiguous: 0.3,
        solicitation: 0.5,
        lowRelevance: 0.5,
      }),
      offTopic: "review",
    };
    const acceptPolicy: ClassificationPolicy = { ...reviewPolicy, offTopic: "accept" };

    const quarantined = evaluateClassificationChecks(
      { model: "jev-v1", spam: 0.05, solicitation: 0.05, relevance: 0.2 },
      reviewPolicy,
      "jev",
      undefined,
      "low-relevance",
    );
    assert.strictEqual(quarantined.relevance.status, "failed");
    assert.strictEqual(quarantined.relevance.decisive, true);

    const labeled = evaluateClassificationChecks(
      { model: "jev-v1", spam: 0.05, solicitation: 0.05, relevance: 0.2 },
      acceptPolicy,
      "jev",
      undefined,
      null,
    );
    assert.strictEqual(labeled.relevance.status, "flagged");
    assert.strictEqual(labeled.relevance.decisive, false);

    const noContext = evaluateClassificationChecks(
      { model: "jev-v1", spam: 0.05, solicitation: 0.05 },
      reviewPolicy,
      "jev",
      undefined,
      null,
    );
    assert.strictEqual(noContext.relevance.status, "not-configured");
    assert.isNull(noContext.relevance.score);
  });

  it("handles legacy scores recorded before solicitation scoring existed", () => {
    const result = evaluateClassificationChecks(
      { model: "jev-v0", spam: 0.05 },
      undefined,
      undefined,
      undefined,
      null,
    );

    assert.strictEqual(result.solicitation.status, "not-evaluated");
    assert.isNull(result.solicitation.score);
  });
});

describe("verification schemas and Effect observability primitives", () => {
  it.effect("rejects invalid intake verification invariants at decode boundaries", () =>
    Effect.gen(function* () {
      const invalid = yield* Effect.exit(
        Schema.decodeEffect(IntakeVerification)({
          channel: "public",
          origin: { _tag: "Passed", mode: "unrestricted", hasOrigin: false },
          honeypot: { _tag: "NotConfigured" },
          turnstile: { _tag: "NotConfigured" },
          repetition: {
            outcome: "passed",
            priorSameSender: -1,
            priorSameContent: 0,
            senderThreshold: 3,
            contentThreshold: 2,
            windowDays: 30,
          },
          blockedTerm: { _tag: "NotConfigured" },
          quota: { _tag: "Passed", used: 0, limit: 500 },
          decisiveReason: null,
        }),
      );
      assert.isTrue(Exit.isFailure(invalid));

      const emptyVerification = yield* Schema.decodeEffect(SubmissionVerification)({
        intake: null,
        intakeReason: null,
        priorSameSender: 0,
        priorSameContent: 0,
        intakeTraceId: null,
        outbox: null,
        events: [],
      });
      assert.isNull(emptyVerification.intake);
    }),
  );

  it.effect("records Effect spans, attributes, span links, and metrics with a custom Tracer", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });

      const intakeTrace = yield* Effect.gen(function* () {
        const span = yield* Effect.currentParentSpan;
        yield* Effect.annotateCurrentSpan({
          "intake.channel": "public",
          "intake.check.repetition": "failed",
        });
        yield* recordMetric(intakeSubmissionsMetric, {
          channel: "public",
          outcome: "quarantined",
          reason: "repetition",
        });
        yield* recordMetric(intakeChecksMetric, { check: "repetition", outcome: "failed" });
        return { traceId: span.traceId, spanId: span.spanId, sampled: span.sampled };
      }).pipe(Effect.withSpan("Intake.receive"), Effect.provideService(Tracer.Tracer, tracer));

      yield* Effect.annotateCurrentSpan({ "outbox.command": "QuarantineAtIntake" }).pipe(
        Effect.withSpan("Outbox.handoff", {
          links: [{ span: Tracer.externalSpan(intakeTrace), attributes: { relation: "intake" } }],
        }),
        Effect.provideService(Tracer.Tracer, tracer),
      );

      assert.strictEqual(spans.length, 2);
      assert.strictEqual(spans[0]?.name, "Intake.receive");
      assert.strictEqual(spans[0]?.attributes.get("intake.check.repetition"), "failed");
      assert.strictEqual(spans[1]?.name, "Outbox.handoff");
      assert.strictEqual(spans[1]?.links[0]?.span.traceId, intakeTrace.traceId);
      assert.strictEqual(spans[1]?.links[0]?.span.spanId, intakeTrace.spanId);

      const counterState = yield* Metric.value(
        Metric.withAttributes(intakeChecksMetric, { check: "repetition", outcome: "failed" }),
      );
      assert.isAtLeast(counterState.count, 1);

      yield* recordMetric(screeningPreviewsMetric, {
        classifier: "jev",
        outcome: "accepted",
        reason: "none",
      });
      const previewCounter = yield* Metric.value(
        Metric.withAttributes(screeningPreviewsMetric, {
          classifier: "jev",
          outcome: "accepted",
          reason: "none",
        }),
      );
      assert.isAtLeast(previewCounter.count, 1);

      const preview = yield* Schema.decodeEffect(ScreeningPreview)({
        outcome: "accepted",
        reason: null,
        label: null,
        blockedTerm: { _tag: "Passed" },
        classifier: "jev",
        policy: jevPolicy,
        scores: { model: "jev-v1", spam: 0.05, solicitation: 0.1, relevance: 0.9 },
        signals: {
          hasBusinessContext: true,
          urlOrHtmlOutsideLongestField: false,
          senderMatchesOrganizationDomain: false,
        },
        rulesVersion: 7,
        traceId: intakeTrace.traceId,
        evaluatedAt: 1_700_000_000_000,
      });
      assert.strictEqual(preview.outcome, "accepted");
    }),
  );
});
