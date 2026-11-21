import { Label } from "./corpus.ts";
import type { ClassifierReport, Report } from "./report.ts";
import { Decision } from "./thresholds.ts";

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
    [
      "id",
      "family",
      "first occurrence",
      "submissions",
      "decision",
      "applied label",
      "spam",
      "solicitation",
      "relevance",
    ],
    decisions.map((entry) => [
      entry.id,
      entry.family ?? "",
      `${entry.firstOccurrence}`,
      `${entry.duplicates}`,
      entry.decision,
      entry.appliedLabel ?? "",
      score(entry.scores?.spam),
      score(entry.scores?.solicitation),
      score(entry.scores?.relevance),
    ]),
  );
}

function costLine(cost: ClassifierReport["cost"]) {
  if (cost._tag === "Unavailable") return `Unavailable: ${cost.reason}`;
  return `${cost.usd.toFixed(6)} USD for ${cost.inputTokens} input and ${cost.outputTokens} output tokens, ${cost.usdPerCall.toFixed(8)} USD per call. Prices from ${cost.pricesSource}, checked on ${cost.pricesCheckedOn}.`;
}

function classifierSummary(report: ClassifierReport) {
  const { thresholds, offTopic } = report.policy;
  const models = report.returnedModels.map(({ model, entries }) => `${model} (${entries})`);
  const latency =
    report.latencyMs === null
      ? "No scored call."
      : `p50 ${report.latencyMs.p50} ms, p90 ${report.latencyMs.p90} ms, p95 ${report.latencyMs.p95} ms, p99 ${report.latencyMs.p99} ms, max ${report.latencyMs.max} ms over ${report.latencyMs.calls} calls.`;
  const { quarantineSpam: metrics } = report;
  return [
    `## ${report.classifier} (${report.requestedModel})`,
    `Policy: probable spam from ${thresholds.probableSpam}, ambiguous from ${thresholds.ambiguous}, solicitation over ${thresholds.solicitation}, low relevance under ${thresholds.lowRelevance}, off-topic handling \`${offTopic}\`.`,
    `Returned model: ${models.length === 0 ? "none" : models.join(", ")}. Scored ${report.calls.scored} inputs, ${report.calls.fromCache} of them from the cache. ${report.calls.failed} failed.`,
    `### Legitimate messages quarantined: ${pair(report.legitimateQuarantined)}`,
    "Rule decisions are listed below. Classification errors are listed with failed calls.",
    decisionTable(report.falsePositives),
    `### Off-topic messages quarantined: ${report.offTopicQuarantined.length}`,
    decisionTable(report.offTopicQuarantined),
    "### Accepted with the off-topic label",
    decisionTable(report.decisions.filter(({ appliedLabel }) => appliedLabel === "off-topic")),
    `### Spam accepted: ${report.spamAccepted.length}`,
    decisionTable(report.spamAccepted),
    "### Quarantined for repetition",
    decisionTable(report.decisions.filter(({ decision }) => decision === "repetition")),
    "### Quarantined for solicitation",
    decisionTable(report.decisions.filter(({ decision }) => decision === "solicitation")),
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
  const { spam, relevance, solicitation, offTopic } = report.sweep;
  const { thresholds: active } = report.policy;
  const highest = Math.max(...spam.map(({ thresholds }) => thresholds.probableSpam));
  const lowest = Math.min(...spam.map(({ thresholds }) => thresholds.ambiguous));
  return [
    `## Threshold sweep: ${report.classifier}`,
    "Recomputed from the recorded scores without new calls. Failed calls and intake quarantines count the same at every point. Entries, then submissions in parentheses.",
    "### Ambiguous threshold",
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
    `### Low relevance threshold, spam thresholds ${threshold(active.probableSpam)} and ${threshold(active.ambiguous)}, solicitation threshold ${threshold(active.solicitation)}`,
    table(
      ["low relevance", "legitimate quarantined", "off-topic quarantined", "spam accepted"],
      relevance.map((point) => [
        threshold(point.thresholds.lowRelevance),
        pair(point.falsePositives),
        pair(point.offTopicQuarantined),
        pair(point.spamAccepted),
      ]),
    ),
    "### Off-topic handling",
    table(
      ["handling", "legitimate quarantined", "off-topic quarantined", "spam accepted"],
      offTopic.map((point) => [
        point.offTopic,
        pair(point.falsePositives),
        pair(point.offTopicQuarantined),
        pair(point.spamAccepted),
      ]),
    ),
    "### Solicitation threshold",
    "A score must be above the threshold. Spam and relevance thresholds stay fixed.",
    table(
      [
        "solicitation",
        "legitimate quarantined",
        "legitimate as solicitation",
        "spam as solicitation",
        "spam accepted",
      ],
      solicitation.map((point) => [
        threshold(point.thresholds.solicitation),
        pair(point.falsePositives),
        pair(point.legitimateAsSolicitation),
        pair(point.spamAsSolicitation),
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
    `${pair(corpus.size)} entries, business context ${corpus.businessContext}. Rules version ${report.rulesVersion}. Gateway \`${report.gateway.id}\`, collectLog ${report.gateway.collectLog}, skipCache ${report.gateway.skipCache}. Generated ${report.generatedAt}.`,
  ];
  return [...header, ...report.classifiers.map(classifierSummary)].join("\n\n");
}

export function renderMarkdown(report: Report) {
  return [renderSummary(report), ...report.classifiers.map(classifierSweep)].join("\n\n") + "\n";
}
