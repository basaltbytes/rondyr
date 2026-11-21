import { Schema } from "effect";

import {
  type ClassificationPolicy,
  ClassificationThresholds,
} from "../src/domain/submissions/classification-policy.ts";
import { ClassificationReason } from "../src/domain/submissions/classification.ts";

export const Decision = Schema.Literals([
  "accepted",
  ...ClassificationReason.literals,
  "repetition",
]);

export type Decision = typeof Decision.Type;

/** Include the active value even when it falls between grid points. */
function grid(active: number) {
  const points = Array.from({ length: 21 }, (_, index) => index / 20);
  return [...new Set([...points, active])].toSorted((a, b) => a - b);
}

export function sweepPolicies(policy: ClassificationPolicy) {
  const { thresholds } = policy;
  const variant = (change: Partial<typeof ClassificationThresholds.Encoded>) => ({
    ...policy,
    thresholds: ClassificationThresholds.make({ ...thresholds, ...change }),
  });
  return {
    spam: grid(thresholds.probableSpam).flatMap((probableSpam) =>
      grid(thresholds.ambiguous)
        .filter((ambiguous) => ambiguous <= probableSpam)
        .map((ambiguous) => variant({ probableSpam, ambiguous })),
    ),
    relevance: grid(thresholds.lowRelevance).map((lowRelevance) => variant({ lowRelevance })),
    solicitation: grid(thresholds.solicitation).map((solicitation) => variant({ solicitation })),
    offTopic: (["review", "accept"] as const).map((offTopic) => ({ ...policy, offTopic })),
  };
}
