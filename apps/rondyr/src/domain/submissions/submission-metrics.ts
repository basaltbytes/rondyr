import { Metric } from "effect";

const durationBoundaries = Metric.exponentialBoundaries({ start: 5, factor: 2, count: 14 });
const attemptBoundaries = [1, 2, 3];

/** Total submissions handled at intake, by channel, outcome and reason. */
export const intakeSubmissionsMetric = Metric.counter("rondyr.intake.submissions", {
  description: "Submissions received at the intake boundary",
  incremental: true,
});

/** Individual intake verification check outcomes, by check name and outcome. */
export const intakeChecksMetric = Metric.counter("rondyr.intake.checks", {
  description: "Outcomes of individual intake verification checks",
  incremental: true,
});

/** Classification runs completed, by classifier, outcome and reason. */
export const classificationRunsMetric = Metric.counter("rondyr.classification.runs", {
  description: "Completed classification runs",
  incremental: true,
});

/** Attempts per classification stage (primary or escalation). */
export const classificationAttemptsMetric = Metric.histogram("rondyr.classification.attempts", {
  description: "Attempts needed per classification stage",
  boundaries: attemptBoundaries,
});

/** Classification model call duration in milliseconds, by classifier and stage. */
export const classificationDurationMetric = Metric.histogram("rondyr.classification.duration_ms", {
  description: "Duration of AI classifier calls in milliseconds",
  boundaries: durationBoundaries,
});

/** Escalation evaluations, by classifier and outcome. */
export const classificationEscalationsMetric = Metric.counter("rondyr.classification.escalations", {
  description: "Second-model escalation evaluations for ambiguous submissions",
  incremental: true,
});

/** Human and API token review actions, by decision and author type. */
export const reviewDecisionsMetric = Metric.counter("rondyr.review.decisions", {
  description: "Manual review decisions applied to quarantined submissions",
  incremental: true,
});

/** Dry-run screening previews run from the dashboard, by classifier, outcome and reason. */
export const screeningPreviewsMetric = Metric.counter("rondyr.screening.previews", {
  description: "Dry-run screening previews run against current saved rules",
  incremental: true,
});

export function recordMetric<M extends Metric.Metric<number, unknown>>(
  metric: M,
  attributes: Record<string, string>,
  value = 1,
) {
  return Metric.update(Metric.withAttributes(metric, attributes), value);
}
