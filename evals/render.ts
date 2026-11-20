import { Label } from "./corpus.ts";
import type { ClassifierReport, Report } from "./report.ts";
import { Decision, currentThresholds } from "./thresholds.ts";

type EntryDecision = ClassifierReport["decisions"][number];
type Count = ClassifierReport["confusion"]["spam"]["accepted"];

function score(value: number | undefined) {
  return value === undefined ? "" : value.toFixed(3);
}

function percent(value: number | null) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)} %`;
}

function pair({ entries, submissions }: Count) {
  return entries === submissions ? `${entries}` : `${entries} (${submissions})`;
}

function table(header: readonly string[], rows: readonly (readonly string[])[]) {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function decisionTable(decisions: readonly EntryDecision[]) {
  if (decisions.length === 0) return "None.";
  return table(
    ["id", "family", "first occurrence", "submissions", "decision", "spam", "relevance"],
    decisions.map((entry) => [
      entry.id,
      entry.family ?? "",
      `${entry.firstOccurrence}`,
      `${entry.duplicates}`,
      entry.decision,
      score(entry.scores?.spam),
      score(entry.scores?.relevance),
    ]),
  );
}

function costLine(cost: ClassifierReport["cost"]) {
  if (cost._tag === "Unavailable") return `Unavailable: ${cost.reason}`;
  return `${cost.usd.toFixed(6)} USD for ${cost.inputTokens} input and ${cost.outputTokens} output tokens, ${cost.usdPerCall.toFixed(8)} USD per call. Prices from ${cost.pricesSource}, checked on ${cost.pricesCheckedOn}.`;
}

function classifierSummary(report: ClassifierReport) {
  const models = report.returnedModels.map(({ model, entries }) => `${model} (${entries})`);
  const latency =
    report.latencyMs === null
      ? "No scored call."
      : `p50 ${report.latencyMs.p50} ms, p90 ${report.latencyMs.p90} ms, p95 ${report.latencyMs.p95} ms, p99 ${report.latencyMs.p99} ms, max ${report.latencyMs.max} ms over ${report.latencyMs.calls} calls.`;
  const { quarantineSpam: metrics } = report;
  return [
    `## ${report.classifier} (${report.requestedModel})`,
    `Returned model: ${models.length === 0 ? "none" : models.join(", ")}. Scored ${report.calls.scored} inputs, ${report.calls.fromCache} of them from the cache. ${report.calls.failed} failed.`,
    `### Legitimate messages quarantined: ${report.falsePositives.length}`,
    decisionTable(report.falsePositives),
    `### Off-topic messages quarantined: ${report.offTopicQuarantined.length}`,
    decisionTable(report.offTopicQuarantined),
    `### Spam accepted: ${report.spamAccepted.length}`,
    decisionTable(report.spamAccepted),
    "### Quarantined for repetition",
    decisionTable(report.decisions.filter(({ decision }) => decision === "repetition")),
    "### Expected label and decision",
    "Distinct corpus lines, then submissions. A line can appear in several decisions when its occurrences differ.",
    table(
      ["label", ...Decision.literals],
      Label.literals.map((label) => [
        label,
        ...Decision.literals.map((decision) => pair(report.confusion[label][decision])),
      ]),
    ),
    "### Quarantine of spam",
    table(
      ["", "entries", "submissions"],
      [
        ["precision", percent(metrics.precision.entries), percent(metrics.precision.submissions)],
        ["recall", percent(metrics.recall.entries), percent(metrics.recall.submissions)],
      ],
    ),
    `Spam quarantined ${pair(metrics.spamQuarantined)}, spam accepted ${pair(metrics.spamAccepted)}, legitimate or off-topic quarantined ${pair(metrics.othersQuarantined)}. Ambiguous entries and failed calls are left out.`,
    "### Latency",
    latency,
    "### Cost",
    costLine(report.cost),
    `### Failed calls: ${report.failures.length}`,
    report.failures.length === 0
      ? "None."
      : table(
          ["id", "label", "first occurrence", "attempts", "retryable", "last error"],
          report.failures.map((failure) => [
            failure.id,
            failure.label,
            `${failure.firstOccurrence ?? 1}`,
            `${failure.attempts}`,
            failure.retryable ? "yes" : "no",
            failure.summary ?? "",
          ]),
        ),
  ].join("\n\n");
}

function threshold(value: number) {
  return value.toFixed(2);
}

// The full grid is in the JSON report. Accepting or quarantining depends only on the lower of the
// two spam thresholds, and the probable-spam reason only on the upper one, so two tables show it.
function classifierSweep(report: ClassifierReport) {
  const { spam, relevance } = report.sweep;
  const highest = Math.max(...spam.map(({ thresholds }) => thresholds.probableSpam));
  const lowest = Math.min(...spam.map(({ thresholds }) => thresholds.ambiguous));
  return [
    `## Threshold sweep: ${report.classifier}`,
    "Recomputed from the recorded scores without new calls. The sweep excludes failed calls and intake quarantines. Entries, then submissions in parentheses.",
    "### Ambiguous threshold: below it, a message with enough relevance is accepted",
    table(
      ["ambiguous", "legitimate quarantined", "off-topic quarantined", "spam accepted"],
      spam
        .filter(({ thresholds }) => thresholds.probableSpam === highest)
        .map((point) => [
          threshold(point.thresholds.ambiguous),
          pair(point.falsePositives),
          pair(point.offTopicQuarantined),
          pair(point.spamAccepted),
        ]),
    ),
    "### Probable spam threshold: from it, the reason is `probable-spam`",
    table(
      ["probable spam", "legitimate as probable spam", "spam as probable spam"],
      spam
        .filter(({ thresholds }) => thresholds.ambiguous === lowest)
        .map((point) => [
          threshold(point.thresholds.probableSpam),
          pair(point.legitimateAsProbableSpam),
          pair(point.spamAsProbableSpam),
        ]),
    ),
    `### Low relevance threshold, spam thresholds ${threshold(currentThresholds.probableSpam)} and ${threshold(currentThresholds.ambiguous)}`,
    table(
      ["low relevance", "legitimate quarantined", "off-topic quarantined", "spam accepted"],
      relevance.map((point) => [
        threshold(point.thresholds.lowRelevance),
        pair(point.falsePositives),
        pair(point.offTopicQuarantined),
        pair(point.spamAccepted),
      ]),
    ),
  ].join("\n\n");
}

/** The report without the threshold sweep, for the terminal. */
export function renderSummary(report: Report) {
  const { corpus } = report;
  const header = [
    `# Classifier evaluation: ${corpus.name}`,
    report.transport === "dry"
      ? "**Dry run: the scores are fake and measure nothing.**"
      : "Scores from Workers AI.",
    `${pair(corpus.size)} entries, business context ${corpus.businessContext}. Rules version ${report.rulesVersion}: probable spam from ${report.thresholds.probableSpam}, ambiguous from ${report.thresholds.ambiguous}, low relevance under ${report.thresholds.lowRelevance}. Gateway \`${report.gateway.id}\`, collectLog ${report.gateway.collectLog}, skipCache ${report.gateway.skipCache}. Generated ${report.generatedAt}.`,
  ];
  return [...header, ...report.classifiers.map(classifierSummary)].join("\n\n");
}

export function renderMarkdown(report: Report) {
  return [renderSummary(report), ...report.classifiers.map(classifierSweep)].join("\n\n") + "\n";
}
