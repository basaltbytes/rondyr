import { Schema } from "effect";

export const Score = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const ClassifierProvider = Schema.Literals(["jev", "openai"]);
export type ClassifierProvider = typeof ClassifierProvider.Type;

export const defaultClassifier = "jev";

export const ClassificationThresholds = Schema.Struct({
  probableSpam: Score,
  ambiguous: Score,
  solicitation: Score,
  lowRelevance: Score,
})
  .check(
    Schema.makeFilter(
      ({ ambiguous, probableSpam }) =>
        ambiguous <= probableSpam || {
          path: ["ambiguous"],
          issue: "The ambiguous threshold must not exceed the probable spam threshold.",
        },
    ),
  )
  .pipe(Schema.brand("ClassificationThresholds"));
export type ClassificationThresholds = typeof ClassificationThresholds.Type;

const OffTopicHandling = Schema.Literals(["review", "accept"]);

export const ClassificationPolicy = Schema.Struct({
  thresholds: ClassificationThresholds,
  offTopic: OffTopicHandling,
  escalation: Schema.optionalKey(Schema.Boolean),
});
export type ClassificationPolicy = typeof ClassificationPolicy.Type;

const baseThresholds = { probableSpam: 0.7, ambiguous: 0.3, solicitation: 0.5 };

export const defaultClassificationPolicies = {
  jev: {
    thresholds: ClassificationThresholds.make({ ...baseThresholds, lowRelevance: 0.5 }),
    offTopic: "review",
  },
  openai: {
    thresholds: ClassificationThresholds.make({ ...baseThresholds, lowRelevance: 0.45 }),
    offTopic: "review",
  },
} as const satisfies Readonly<Record<ClassifierProvider, ClassificationPolicy>>;

export const ResolvedClassificationPolicy = Schema.Struct({
  classifier: ClassifierProvider,
  policy: ClassificationPolicy,
  escalationClassifier: Schema.optionalKey(ClassifierProvider),
});
