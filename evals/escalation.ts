import { Effect, Option, Schema } from "effect";

import {
  ClassificationPolicy,
  ClassificationThresholds,
  defaultClassificationPolicies,
} from "../src/domain/submissions/classification-policy.ts";
import { escalatedDecision, rulesVersion } from "../src/domain/submissions/classification.ts";
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
          solicitation: Count,
          lowRelevance: Count,
          secondMissing: Count,
        }),
      ),
    }),
  ),
});

/** The report column of each final reason that an escalated decision can give. */
const quarantineColumns = {
  ambiguous: "stillAmbiguous",
  solicitation: "solicitation",
  "low-relevance": "lowRelevance",
} as const;

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
            const secondKey = yield* inputCacheKey(transport, second, entry.id, input);
            const cached = yield* cache.get(secondKey);
            const decision = escalatedDecision(first.value.scores, policy, {
              classifier: second,
              ...(Option.isSome(cached) && { scores: cached.value.scores }),
            });
            // The first scores leave no spam doubt, so the second model is not called.
            if (decision === undefined) return [];
            if (Option.isNone(cached)) return [{ entry, outcome: "secondMissing" }] as const;
            const outcome =
              decision.reason !== null
                ? quarantineColumns[decision.reason]
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
          solicitation: tally(label, "solicitation"),
          lowRelevance: tally(label, "lowRelevance"),
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
      "| Expected label | Accepted | Accepted as off-topic | Still ambiguous | Solicitation | Low relevance | Missing second score | Missing primary score |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...Object.entries(labels).map(
        ([label, row]) =>
          `| ${label} | ${[row.accepted, row.acceptedOffTopic, row.stillAmbiguous, row.solicitation, row.lowRelevance, row.secondMissing, row.primaryMissing].map(pair).join(" | ")} |`,
      ),
    ].join("\n"),
  );
  return [
    `# Classifier escalation, rules version ${report.rulesVersion}`,
    report.transport === "dry"
      ? "**Dry run: the scores are fake and measure nothing.**"
      : "Cached Workers AI scores.",
    "Counts show corpus lines, then submissions in parentheses. Each counted submission starts in quarantine as ambiguous, and the columns give its final decision. The second model settles the spam doubt only: when it finds nothing, the primary model's solicitation and low relevance rules still apply. A missing second score leaves the submission ambiguous. A missing primary score leaves the first decision unknown.",
    ...sections,
  ].join("\n\n");
}
