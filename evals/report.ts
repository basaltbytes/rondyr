import { Schema } from "effect";

import { aiGatewayOptions } from "../src/adapters/ai/gateway.ts";
import {
  ClassificationPolicy,
  ClassificationThresholds,
  defaultClassificationPolicies,
} from "../src/domain/submissions/classification-policy.ts";
import {
  ClassificationScores,
  isOffTopic,
  reviewReason,
  rulesVersion,
  SubmissionLabel,
} from "../src/domain/submissions/classification.ts";
import { ClassifierName, classifiers } from "./classifiers.ts";
import { type Corpus, type CorpusEntry, EntryId, Family, Label, weight } from "./corpus.ts";
import type { ClassifierRun, EntryResult, Outcome } from "./evaluate.ts";
import { Decision, sweepPolicies } from "./thresholds.ts";
import { Transport } from "./workers-ai.ts";

/** A count of corpus lines, and of the submissions they stand for once `duplicates` is applied. */
const Count = Schema.Struct({ entries: Schema.Int, submissions: Schema.Int });

type Count = typeof Count.Type;

const Rate = Schema.NullOr(Schema.Finite);

const RateBySubmission = Schema.Struct({ entries: Rate, submissions: Rate });

const EntryDecision = Schema.Struct({
  id: EntryId,
  label: Label,
  family: Schema.optionalKey(Family),
  duplicates: Schema.Int,
  firstOccurrence: Schema.Int,
  decision: Decision,
  appliedLabel: Schema.optionalKey(SubmissionLabel),
  scores: Schema.optionalKey(ClassificationScores),
});

type EntryDecision = typeof EntryDecision.Type;

const Failure = Schema.Struct({
  id: EntryId,
  label: Label,
  attempts: Schema.Int,
  firstOccurrence: Schema.optionalKey(Schema.Int),
  retryable: Schema.Boolean,
  httpStatus: Schema.optionalKey(Schema.Int),
  summary: Schema.optionalKey(Schema.String),
});

const Latency = Schema.Struct({
  calls: Schema.Int,
  p50: Schema.Finite,
  p90: Schema.Finite,
  p95: Schema.Finite,
  p99: Schema.Finite,
  max: Schema.Finite,
});

const Cost = Schema.Union([
  Schema.TaggedStruct("Estimated", {
    usd: Schema.Finite,
    usdPerCall: Schema.Finite,
    inputTokens: Schema.Int,
    outputTokens: Schema.Int,
    pricesSource: Schema.String,
    pricesCheckedOn: Schema.String,
  }),
  Schema.TaggedStruct("Unavailable", { reason: Schema.String }),
]);

type Cost = typeof Cost.Type;

const SweepPoint = Schema.Struct({
  thresholds: ClassificationThresholds,
  offTopic: ClassificationPolicy.fields.offTopic,
  falsePositives: Count,
  spamAccepted: Count,
  offTopicQuarantined: Count,
  legitimateAsProbableSpam: Count,
  spamAsProbableSpam: Count,
  legitimateAsSolicitation: Count,
  spamAsSolicitation: Count,
});

type SweepPoint = typeof SweepPoint.Type;

const ClassifierReport = Schema.Struct({
  classifier: ClassifierName,
  requestedModel: Schema.String,
  policy: ClassificationPolicy,
  returnedModels: Schema.Array(Schema.Struct({ model: Schema.String, entries: Schema.Int })),
  calls: Schema.Struct({ scored: Schema.Int, fromCache: Schema.Int, failed: Schema.Int }),
  falsePositives: Schema.Array(EntryDecision),
  legitimateQuarantined: Count,
  offTopicQuarantined: Schema.Array(EntryDecision),
  spamAccepted: Schema.Array(EntryDecision),
  failures: Schema.Array(Failure),
  confusion: Schema.Record(Label, Schema.Record(Decision, Count)),
  /** Spam is the positive class; legitimate and off-topic entries are the negatives. */
  quarantineSpam: Schema.Struct({
    spamQuarantined: Count,
    spamAccepted: Count,
    othersQuarantined: Count,
    precision: RateBySubmission,
    recall: RateBySubmission,
  }),
  latencyMs: Schema.NullOr(Latency),
  cost: Cost,
  sweep: Schema.Struct({
    spam: Schema.Array(SweepPoint),
    relevance: Schema.Array(SweepPoint),
    solicitation: Schema.Array(SweepPoint),
    offTopic: Schema.Array(SweepPoint),
  }),
  decisions: Schema.Array(EntryDecision),
});

export type ClassifierReport = typeof ClassifierReport.Type;

/** The JSON report. It contains ids, labels, families, scores and decisions, never field values. */
export const Report = Schema.Struct({
  format: Schema.Literal("rondyr-classifier-evaluation/4"),
  generatedAt: Schema.String,
  transport: Transport,
  corpus: Schema.Struct({
    name: Schema.String,
    size: Count,
    labels: Schema.Record(Label, Count),
    businessContext: Schema.Literals(["provided", "empty"]),
  }),
  rulesVersion: Schema.Int,
  gateway: Schema.Struct({
    id: Schema.String,
    collectLog: Schema.Boolean,
    skipCache: Schema.Boolean,
  }),
  classifiers: Schema.Array(ClassifierReport),
});

export type Report = typeof Report.Type;

function byLabel<A>(value: (label: Label) => A) {
  return {
    legitimate: value("legitimate"),
    spam: value("spam"),
    ambiguous: value("ambiguous"),
    "off-topic": value("off-topic"),
  };
}

function byDecision<A>(value: (decision: Decision) => A) {
  return {
    accepted: value("accepted"),
    "probable-spam": value("probable-spam"),
    ambiguous: value("ambiguous"),
    solicitation: value("solicitation"),
    "low-relevance": value("low-relevance"),
    "classification-error": value("classification-error"),
    repetition: value("repetition"),
  };
}

export function decisionOf(outcome: Outcome, policy: ClassificationPolicy): Decision {
  if (outcome._tag === "Failed") return "classification-error";
  if (outcome._tag === "Repetition") return "repetition";
  return reviewReason(outcome.call.scores, policy) ?? "accepted";
}

function count(entries: readonly CorpusEntry[]): Count {
  return {
    entries: new Set(entries.map(({ id }) => id)).size,
    submissions: entries.reduce((total, entry) => total + weight(entry), 0),
  };
}

function rate(numerator: Count, denominator: Count) {
  return {
    entries: denominator.entries === 0 ? null : numerator.entries / denominator.entries,
    submissions:
      denominator.submissions === 0 ? null : numerator.submissions / denominator.submissions,
  };
}

function sum(left: Count, right: Count): Count {
  return {
    entries: left.entries + right.entries,
    submissions: left.submissions + right.submissions,
  };
}

function entryDecision(
  { entry, outcome, firstOccurrence = 1 }: EntryResult,
  policy: ClassificationPolicy,
): EntryDecision {
  const decision = {
    id: entry.id,
    label: entry.label,
    duplicates: weight(entry),
    firstOccurrence,
    decision: decisionOf(outcome, policy),
  };
  const withFamily = entry.family === undefined ? decision : { ...decision, family: entry.family };
  if (outcome._tag !== "Scored") return withFamily;
  const { scores } = outcome.call;
  if (decision.decision === "accepted" && isOffTopic(scores, policy)) {
    return { ...withFamily, scores, appliedLabel: "off-topic" };
  }
  return { ...withFamily, scores };
}

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: readonly number[], rank: number) {
  const index = Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function latency(results: readonly EntryResult[]) {
  const sorted = results
    .flatMap(({ outcome }) => (outcome._tag === "Scored" ? [outcome.call.latencyMs] : []))
    .toSorted((left, right) => left - right);
  if (sorted.length === 0) return null;
  return {
    calls: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
}

function cost(run: ClassifierRun): Cost {
  const scored = run.results.flatMap(({ entry, outcome }) =>
    outcome._tag === "Scored" ? [{ entry, call: outcome.call }] : [],
  );
  if (scored.length === 0) return { _tag: "Unavailable", reason: "No call returned scores." };
  const missing = scored.filter(({ call }) => call.usage === undefined).length;
  if (missing > 0) {
    return {
      _tag: "Unavailable",
      reason: `${missing} of ${scored.length} responses had no token usage.`,
    };
  }
  const { prices } = classifiers[run.classifier];
  let inputTokens = 0;
  let outputTokens = 0;
  let usd = 0;
  for (const { call } of scored) {
    if (call.usage === undefined) continue;
    const cachedTokens = call.usage.input_tokens_details?.cached_tokens ?? 0;
    inputTokens += call.usage.input_tokens;
    outputTokens += call.usage.output_tokens;
    usd +=
      ((call.usage.input_tokens - cachedTokens) * prices.input +
        cachedTokens * prices.cachedInput +
        call.usage.output_tokens * prices.output) /
      1e6;
  }
  return {
    _tag: "Estimated",
    usd,
    usdPerCall: usd / scored.length,
    inputTokens,
    outputTokens,
    pricesSource: prices.source,
    pricesCheckedOn: prices.checkedOn,
  };
}

function sweepPoint(policy: ClassificationPolicy, results: readonly EntryResult[]): SweepPoint {
  const decided = results.map(({ entry, outcome }) => ({
    entry,
    decision: decisionOf(outcome, policy),
  }));
  const pick = (label: CorpusEntry["label"], keep: (decision: Decision) => boolean) =>
    count(
      decided
        .filter(({ entry, decision }) => entry.label === label && keep(decision))
        .map(({ entry }) => entry),
    );
  return {
    ...policy,
    falsePositives: pick("legitimate", (decision) => decision !== "accepted"),
    spamAccepted: pick("spam", (decision) => decision === "accepted"),
    offTopicQuarantined: pick("off-topic", (decision) => decision !== "accepted"),
    legitimateAsProbableSpam: pick("legitimate", (reason) => reason === "probable-spam"),
    spamAsProbableSpam: pick("spam", (reason) => reason === "probable-spam"),
    legitimateAsSolicitation: pick("legitimate", (reason) => reason === "solicitation"),
    spamAsSolicitation: pick("spam", (reason) => reason === "solicitation"),
  };
}

function sweep(results: readonly EntryResult[], policy: ClassificationPolicy) {
  const variants = sweepPolicies(policy);
  const points = (policies: readonly ClassificationPolicy[]) =>
    policies.map((variant) => sweepPoint(variant, results));
  return {
    spam: points(variants.spam),
    relevance: points(variants.relevance),
    solicitation: points(variants.solicitation),
    offTopic: points(variants.offTopic),
  };
}

/** Quarantined by a rule. Failed model calls are excluded from these metrics. */
function quarantinedByRule(decision: Decision) {
  return decision !== "accepted" && decision !== "classification-error";
}

function byId(left: EntryDecision, right: EntryDecision) {
  return left.id.localeCompare(right.id) || left.firstOccurrence - right.firstOccurrence;
}

export function classifierReport(
  run: ClassifierRun,
  policy: ClassificationPolicy = defaultClassificationPolicies[run.classifier],
): ClassifierReport {
  const decisions = run.results.map((result) => entryDecision(result, policy));
  const entriesWith = (label: Label, keep: (decision: Decision) => boolean) =>
    run.results.filter(
      ({ entry, outcome }) => entry.label === label && keep(decisionOf(outcome, policy)),
    );

  const confusion = byLabel((label) =>
    byDecision((decision) =>
      count(entriesWith(label, (other) => other === decision).map(({ entry }) => entry)),
    ),
  );

  const spamQuarantined = count(entriesWith("spam", quarantinedByRule).map(({ entry }) => entry));
  const spamAccepted = count(
    entriesWith("spam", (decision) => decision === "accepted").map(({ entry }) => entry),
  );
  const othersQuarantined = sum(
    count(entriesWith("legitimate", quarantinedByRule).map(({ entry }) => entry)),
    count(entriesWith("off-topic", quarantinedByRule).map(({ entry }) => entry)),
  );
  const spamDecided = count(
    entriesWith("spam", (decision) => decision !== "classification-error").map(
      ({ entry }) => entry,
    ),
  );

  const returned = new Map<string, number>();
  for (const { outcome } of run.results) {
    if (outcome._tag === "Scored") {
      returned.set(outcome.call.scores.model, (returned.get(outcome.call.scores.model) ?? 0) + 1);
    }
  }

  return {
    classifier: run.classifier,
    requestedModel: run.model,
    policy,
    returnedModels: [...returned].map(([model, entries]) => ({ model, entries })),
    calls: {
      scored: run.results.filter(({ outcome }) => outcome._tag === "Scored").length,
      fromCache: run.results.filter(({ outcome }) => outcome._tag === "Scored" && outcome.cached)
        .length,
      failed: run.results.filter(({ outcome }) => outcome._tag === "Failed").length,
    },
    falsePositives: decisions
      .filter(({ label, decision }) => label === "legitimate" && quarantinedByRule(decision))
      .toSorted(byId),
    legitimateQuarantined: count(
      entriesWith("legitimate", (decision) => decision !== "accepted").map(({ entry }) => entry),
    ),
    offTopicQuarantined: decisions
      .filter(({ label, decision }) => label === "off-topic" && quarantinedByRule(decision))
      .toSorted(byId),
    spamAccepted: decisions
      .filter(({ label, decision }) => label === "spam" && decision === "accepted")
      .toSorted(byId),
    failures: run.results.flatMap(({ entry, outcome, firstOccurrence }) => {
      if (outcome._tag !== "Failed") return [];
      const { _tag, ...failure } = outcome;
      const row = { id: entry.id, label: entry.label, ...failure };
      return [firstOccurrence === undefined ? row : { ...row, firstOccurrence }];
    }),
    confusion,
    quarantineSpam: {
      spamQuarantined,
      spamAccepted,
      othersQuarantined,
      precision: rate(spamQuarantined, sum(spamQuarantined, othersQuarantined)),
      recall: rate(spamQuarantined, spamDecided),
    },
    latencyMs: latency(run.results),
    cost: cost(run),
    sweep: sweep(run.results, policy),
    decisions,
  };
}

export function buildReport(
  corpus: Corpus,
  runs: readonly ClassifierRun[],
  transport: Transport,
  generatedAt: string,
  policy?: ClassificationPolicy,
): Report {
  return {
    format: "rondyr-classifier-evaluation/4",
    generatedAt,
    transport,
    corpus: {
      name: corpus.name,
      size: count(corpus.entries),
      labels: byLabel((label) => count(corpus.entries.filter((entry) => entry.label === label))),
      businessContext: corpus.context === "" ? "empty" : "provided",
    },
    rulesVersion,
    gateway: aiGatewayOptions.gateway,
    classifiers: runs.map((run) => classifierReport(run, policy)),
  };
}

export const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Report, { space: 2 }));
