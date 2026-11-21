import { Effect, Option, Schema } from "effect";

import {
  ClassificationPolicy,
  ClassificationThresholds,
  defaultClassificationPolicies,
} from "../src/domain/submissions/classification-policy.ts";
import {
  classificationDecision,
  reviewReason,
  rulesVersion,
} from "../src/domain/submissions/classification.ts";
import { ResultCache } from "./cache.ts";
import { ClassifierName } from "./classifiers.ts";
import { type Corpus, Label } from "./corpus.ts";
import { inputCacheKey } from "./evaluate.ts";
import { replay } from "./replay.ts";
import { byLabel, Count, count } from "./report.ts";
import { Transport } from "./workers-ai.ts";

const EscalationReport = Schema.Struct({
  format: Schema.Literal("rondyr-classifier-escalation/1"),
  transport: Transport,
  rulesVersion: Schema.Int,
  directions: Schema.Array(
    Schema.Struct({
      primary: ClassifierName,
      second: ClassifierName,
      policy: ClassificationPolicy,
      secondThresholds: ClassificationThresholds,
      byLabel: Schema.Record(
        Label,
        Schema.Struct({
          primaryMissing: Count,
          accepted: Count,
          acceptedOffTopic: Count,
          stillAmbiguous: Count,
          secondMissing: Count,
        }),
      ),
    }),
  ),
});

export const evaluateEscalation = Effect.fn("Evaluation.escalation")(function* (
  corpus: Corpus,
  primaries: readonly ClassifierName[],
  transport: Transport,
  concurrency: number,
  override?: ClassificationPolicy,
) {
  const cache = yield* ResultCache;
  const inputs = replay(corpus);
  const directions = yield* Effect.forEach(primaries, (primary) =>
    Effect.gen(function* () {
      const second: ClassifierName = primary === "jev" ? "openai" : "jev";
      const policy = override ?? defaultClassificationPolicies[primary];
      const results = yield* Effect.forEach(
        inputs,
        ({ entry, input }) =>
          Effect.gen(function* () {
            if (input === null) return [];
            const primaryKey = yield* inputCacheKey(transport, primary, entry.id, input);
            const first = yield* cache.get(primaryKey);
            if (Option.isNone(first)) return [{ entry, outcome: "primaryMissing" }] as const;
            const { scores } = first.value;
            if (reviewReason(scores, policy) !== "ambiguous") return [];
            const secondKey = yield* inputCacheKey(transport, second, entry.id, input);
            const cached = yield* cache.get(secondKey);
            if (Option.isNone(cached)) return [{ entry, outcome: "secondMissing" }] as const;
            const decision = classificationDecision(scores, policy, {
              classifier: second,
              scores: cached.value.scores,
            });
            const outcome =
              decision.reason !== null
                ? "stillAmbiguous"
                : decision.label === "off-topic"
                  ? "acceptedOffTopic"
                  : "accepted";
            return [{ entry, outcome }] as const;
          }),
        { concurrency },
      );
      const rows = results.flat();
      const tally = (label: Label, status: (typeof rows)[number]["outcome"]) =>
        count(
          rows
            .filter(({ entry, outcome }) => entry.label === label && outcome === status)
            .map(({ entry }) => entry),
        );
      return {
        primary,
        second,
        policy,
        secondThresholds: defaultClassificationPolicies[second].thresholds,
        byLabel: byLabel((label) => ({
          primaryMissing: tally(label, "primaryMissing"),
          accepted: tally(label, "accepted"),
          acceptedOffTopic: tally(label, "acceptedOffTopic"),
          stillAmbiguous: tally(label, "stillAmbiguous"),
          secondMissing: tally(label, "secondMissing"),
        })),
      };
    }),
  );
  return {
    format: "rondyr-classifier-escalation/1",
    transport,
    rulesVersion,
    directions,
  } satisfies typeof EscalationReport.Type;
});

export const encodeEscalation = Schema.encodeEffect(
  Schema.fromJsonString(EscalationReport, { space: 2 }),
);

function pair({ entries, submissions }: ReturnType<typeof count>) {
  return `${entries} (${submissions})`;
}

export function renderEscalation(report: typeof EscalationReport.Type) {
  const sections = report.directions.map(({ primary, second, byLabel: labels }) =>
    [
      `## ${primary} → ${second}`,
      "| Expected label | Accepted | Accepted as off-topic | Still ambiguous | Missing second score | Missing primary score |",
      "| --- | --- | --- | --- | --- | --- |",
      ...Object.entries(labels).map(
        ([label, row]) =>
          `| ${label} | ${[row.accepted, row.acceptedOffTopic, row.stillAmbiguous, row.secondMissing, row.primaryMissing].map(pair).join(" | ")} |`,
      ),
    ].join("\n"),
  );
  return [
    `# Classifier escalation, rules version ${report.rulesVersion}`,
    report.transport === "dry"
      ? "**Dry run: the scores are fake and measure nothing.**"
      : "Cached Workers AI scores.",
    "Counts show corpus lines, then submissions in parentheses. Each accepted or still ambiguous submission starts in quarantine. A missing second score leaves it there. A missing primary score leaves the first decision unknown.",
    ...sections,
  ].join("\n\n");
}
