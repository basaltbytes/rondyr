import { assert, describe, it } from "@effect/vitest";

import {
  ClassificationThresholds,
  defaultClassificationPolicies,
  type ClassificationPolicy,
} from "./classification-policy.ts";
import { evaluateClassificationChecks } from "./verification.ts";

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
