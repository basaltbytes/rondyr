import { assert, it } from "@effect/vitest";

import {
  classificationThresholds,
  reviewReason,
} from "../src/domain/submissions/classification.ts";
import { decisionOf } from "./report.ts";
import { reasonAt } from "./thresholds.ts";

const scored = (spam: number, relevance?: number, solicitation = 0) => ({
  _tag: "Scored" as const,
  cached: false,
  call: {
    latencyMs: 1,
    scores:
      relevance === undefined
        ? { model: "m", spam, solicitation }
        : { model: "m", spam, solicitation, relevance },
  },
});

it("maps scores to the Worker's decision at each threshold", () => {
  const cases = [
    [scored(0.7), "probable-spam"],
    [scored(0.6999), "ambiguous"],
    [scored(0.3), "ambiguous"],
    [scored(0.2999), "accepted"],
    [scored(0.2999, 0.35), "accepted"],
    [scored(0.2999, 0.3499), "low-relevance"],
    [scored(0.3, 0.01), "ambiguous"],
    [scored(0, 0), "low-relevance"],
    [scored(0.2999, 0.01, 0.5001), "solicitation"],
    [scored(0.2999, 0.35, 0.5), "accepted"],
    [scored(0.3, 0.9, 0.99), "ambiguous"],
    [
      { _tag: "Scored", call: { scores: { model: "m", spam: 0 }, latencyMs: 1 }, cached: false },
      "classification-error",
    ],
    [{ _tag: "Failed", attempts: 3, retryable: true } as const, "classification-error"],
  ] as const;
  for (const [outcome, decision] of cases) assert.strictEqual(decisionOf(outcome), decision);
});

it("keeps the sweep rules identical to reviewReason at the current thresholds", () => {
  const steps = Array.from({ length: 1001 }, (_, index) => index / 1000);
  for (const spam of steps) {
    for (const relevance of [
      undefined,
      ...steps.filter((_, index) => index % 10 === 0),
      0.349,
      0.351,
    ]) {
      const scores =
        relevance === undefined
          ? { model: "m", spam, solicitation: 0.9 }
          : { model: "m", spam, solicitation: 0.9, relevance };
      assert.strictEqual(reasonAt(classificationThresholds, scores), reviewReason(scores));
    }
  }
});
