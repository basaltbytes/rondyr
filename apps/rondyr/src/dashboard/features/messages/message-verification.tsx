import { useMutation } from "@tanstack/react-query";
import { cn } from "cn";
import type { TFunction } from "i18next";
import { AlertTriangle, Check, ChevronRight, Clock, FlaskConical, Minus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type {
  ClassificationScores,
  ClassificationSignals,
  EscalationEvaluation,
  QuarantineReason,
} from "@rondyr/contracts/classification";
import type {
  ClassificationPolicy,
  ClassifierProvider,
} from "@rondyr/contracts/classification-policy";
import { repetitionThresholds } from "@rondyr/contracts/classifier-input";
import {
  evaluateClassificationChecks,
  type EventActor,
  type IntakeVerification,
  type ScreeningPreview,
  type SubmissionTimelineEvent,
  type SubmissionVerification,
} from "@rondyr/contracts/verification";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { testScreeningMutation, type InboxRow, type SubmissionDetail } from "~/lib/api/messages";
import { statusOf } from "~/lib/api/request";
import { useFormats } from "~/lib/i18n";

type CheckTone = "passed" | "failed" | "warning" | "skipped" | "not-configured" | "pending";

type SummaryBadgeKind =
  | "accepted-automatic"
  | "accepted-manual"
  | "stopped-at-intake"
  | "flagged-by-ai"
  | "analysis-failed"
  | "archived"
  | "analyzing"
  | "queued"
  | "stuck";

const badgeVariants = {
  "accepted-automatic": "success",
  "accepted-manual": "success",
  "stopped-at-intake": "warning",
  "flagged-by-ai": "warning",
  "analysis-failed": "destructive",
  archived: "neutral",
  analyzing: "neutral",
  queued: "neutral",
  stuck: "destructive",
} as const satisfies Record<SummaryBadgeKind, "success" | "warning" | "destructive" | "neutral">;

const toneStyles = {
  passed: {
    icon: "bg-success-subtle text-success",
    label: "text-success",
  },
  failed: {
    icon: "bg-destructive-subtle text-destructive",
    label: "text-destructive",
  },
  warning: {
    icon: "bg-warning-subtle text-warning",
    label: "text-warning",
  },
  skipped: {
    icon: "bg-muted text-muted-foreground",
    label: "text-muted-foreground",
  },
  "not-configured": {
    icon: "bg-muted text-muted-foreground",
    label: "text-muted-foreground",
  },
  pending: {
    icon: "bg-muted text-muted-foreground",
    label: "text-muted-foreground",
  },
} as const satisfies Record<CheckTone, { readonly icon: string; readonly label: string }>;

function CheckIcon({ tone }: { readonly tone: CheckTone }) {
  const Icon =
    tone === "passed"
      ? Check
      : tone === "failed"
        ? X
        : tone === "warning"
          ? AlertTriangle
          : tone === "pending"
            ? Clock
            : Minus;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
        toneStyles[tone].icon,
      )}
    >
      <Icon className="size-3" />
    </span>
  );
}

interface CheckRowProps {
  readonly tone: CheckTone;
  readonly name: string;
  readonly stateLabel: string;
  readonly detail: ReactNode;
  readonly highlight?: boolean;
}

function CheckRow({ tone, name, stateLabel, detail, highlight }: CheckRowProps) {
  return (
    <li
      className={cn(
        "flex items-start gap-2.5 rounded-md px-2.5 py-2 text-sm",
        highlight === true && "bg-warning-subtle/50",
      )}
    >
      <CheckIcon tone={tone} />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="font-medium">{name}</span>
          <span className={cn("text-xs font-medium", toneStyles[tone].label)}>{stateLabel}</span>
        </div>
        <div className="text-xs text-pretty text-muted-foreground">{detail}</div>
      </div>
    </li>
  );
}

interface ScoreBarProps {
  readonly score: number;
  readonly markers: ReadonlyArray<{ readonly value: number; readonly emphasis?: boolean }>;
  readonly tone: "passed" | "warning" | "failed";
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(1, value)) * 100;
}

function ScoreBar({ score, markers, tone }: ScoreBarProps) {
  const fillClass =
    tone === "failed" ? "fill-destructive" : tone === "warning" ? "fill-warning" : "fill-success";
  const width = clampPercent(score);
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 10"
      preserveAspectRatio="none"
      className="mt-1 h-2.5 w-full overflow-visible"
    >
      <rect x="0" y="2" width="100" height="6" rx="3" className="fill-muted" />
      {width > 0 && <rect x="0" y="2" width={width} height="6" rx="3" className={fillClass} />}
      {markers.map((marker, index) => {
        const position = clampPercent(marker.value);
        return (
          <line
            key={index}
            x1={position}
            x2={position}
            y1="0"
            y2="10"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            className={
              marker.emphasis === true ? "stroke-foreground/70" : "stroke-muted-foreground/60"
            }
          />
        );
      })}
    </svg>
  );
}

function formatClassifierName(
  t: TFunction,
  classifier: ClassifierProvider | undefined,
  model?: string,
) {
  if (classifier === "openai") return t("inbox.policy.models.openai");
  if (classifier === "jev") return t("inbox.policy.models.jev");
  if (model !== undefined && model.toLowerCase().includes("openai")) {
    return t("inbox.policy.models.openai");
  }
  return t("inbox.policy.models.jev");
}

function formatActor(t: TFunction, actor: EventActor | undefined) {
  if (actor === undefined) return t("verification.actors.unknown");
  if (actor._tag === "Reviewer") {
    return actor.name ?? t("verification.actors.member");
  }
  if (actor.name !== null && actor.suffix !== null) {
    return t("verification.actors.apiTokenNamed", {
      name: actor.name,
      suffix: actor.suffix,
    });
  }
  if (actor.name !== null) {
    return t("verification.actors.apiTokenOnlyName", { name: actor.name });
  }
  return t("verification.actors.apiToken");
}

type AcceptedEventDetail = Extract<
  SubmissionTimelineEvent["detail"],
  { readonly _tag: "SubmissionAccepted" }
>;
type QuarantinedEventDetail = Extract<
  SubmissionTimelineEvent["detail"],
  { readonly _tag: "SubmissionQuarantined" }
>;

function findLastAccepted(events: ReadonlyArray<SubmissionTimelineEvent>) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const candidate = events[i];
    if (candidate !== undefined && candidate.detail._tag === "SubmissionAccepted") {
      return { ...candidate, detail: candidate.detail };
    }
  }
  return undefined;
}

function findLastDismissed(events: ReadonlyArray<SubmissionTimelineEvent>) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const candidate = events[i];
    if (candidate !== undefined && candidate.detail._tag === "SubmissionDismissed") {
      return { ...candidate, detail: candidate.detail };
    }
  }
  return undefined;
}

function findLastQuarantined(events: ReadonlyArray<SubmissionTimelineEvent>) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const candidate = events[i];
    if (candidate !== undefined && candidate.detail._tag === "SubmissionQuarantined") {
      return { ...candidate, detail: candidate.detail };
    }
  }
  return undefined;
}

type ClassificationOutcome =
  | (Omit<SubmissionTimelineEvent, "detail"> & { readonly detail: AcceptedEventDetail })
  | (Omit<SubmissionTimelineEvent, "detail"> & { readonly detail: QuarantinedEventDetail });

function findLastClassificationOutcome(
  events: ReadonlyArray<SubmissionTimelineEvent>,
): ClassificationOutcome | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const candidate = events[i];
    if (candidate === undefined) continue;
    if (
      candidate.detail._tag === "SubmissionAccepted" &&
      candidate.detail.mode === "automatic" &&
      candidate.detail.scores !== undefined
    ) {
      return { ...candidate, detail: candidate.detail };
    }
    if (
      candidate.detail._tag === "SubmissionQuarantined" &&
      (candidate.detail.scores !== undefined ||
        candidate.detail.failure !== undefined ||
        candidate.detail.reason === "classification-error")
    ) {
      return { ...candidate, detail: candidate.detail };
    }
  }
  return undefined;
}

function summaryBadgeOf(
  entry: InboxRow,
  verification: SubmissionVerification,
  acceptedEvent:
    | (Omit<SubmissionTimelineEvent, "detail"> & { readonly detail: AcceptedEventDetail })
    | undefined,
): SummaryBadgeKind {
  if (entry.status === "accepted") {
    return acceptedEvent?.detail.mode === "manual" ? "accepted-manual" : "accepted-automatic";
  }
  if (entry.status === "archived") return "archived";
  if (entry.status === "classifying") return "analyzing";
  if (entry.status === "received") {
    return verification.outbox?.stuckAt != null ? "stuck" : "queued";
  }
  if (entry.reason === "classification-error") return "analysis-failed";
  if (verification.intakeReason !== null) return "stopped-at-intake";
  return "flagged-by-ai";
}

function IntakeChecksList({
  intake,
  verification,
}: {
  readonly intake: IntakeVerification | null;
  readonly verification: SubmissionVerification;
}) {
  const { t } = useTranslation();
  const format = useFormats();

  if (intake === null) {
    const senderLimit = repetitionThresholds.sender;
    const contentLimit = repetitionThresholds.content;
    const repetitionFailed =
      verification.priorSameSender >= senderLimit || verification.priorSameContent >= contentLimit;
    return (
      <div className="grid gap-2">
        <p className="text-xs text-pretty text-muted-foreground">
          {t("verification.intake.legacyNotice")}
        </p>
        <ul className="grid gap-1">
          <CheckRow
            tone={repetitionFailed ? "failed" : "passed"}
            highlight={verification.intakeReason === "repetition"}
            name={t("verification.intake.repetitionName")}
            stateLabel={t(`verification.checkStates.${repetitionFailed ? "failed" : "passed"}`)}
            detail={t("verification.intake.repetitionDetail", {
              senderCount: format.count(verification.priorSameSender),
              senderLimit: format.count(senderLimit),
              contentCount: format.count(verification.priorSameContent),
              contentLimit: format.count(contentLimit),
              days: format.count(30),
            })}
          />
        </ul>
      </div>
    );
  }

  const originTone: CheckTone = intake.origin._tag === "Passed" ? "passed" : "skipped";
  const originDetail =
    intake.origin._tag === "Skipped"
      ? t("verification.intake.originServerSkipped")
      : intake.origin.mode === "listed"
        ? intake.origin.hasOrigin
          ? t("verification.intake.originListedMatched")
          : t("verification.intake.originListedNoHeader")
        : t("verification.intake.originUnrestricted");

  const honeypotTone: CheckTone =
    intake.honeypot._tag === "Passed"
      ? "passed"
      : intake.honeypot._tag === "Failed"
        ? "failed"
        : "not-configured";
  const honeypotDetail =
    intake.honeypot._tag === "NotConfigured"
      ? t("verification.intake.honeypotNotConfigured")
      : intake.honeypot._tag === "Passed"
        ? t("verification.intake.honeypotPassed", { field: intake.honeypot.field })
        : t("verification.intake.honeypotFailed", { field: intake.honeypot.field });

  const turnstileTone: CheckTone =
    intake.turnstile._tag === "Passed"
      ? "passed"
      : intake.turnstile._tag === "Failed"
        ? "failed"
        : intake.turnstile._tag === "Unavailable"
          ? "warning"
          : intake.turnstile._tag === "Skipped"
            ? "skipped"
            : "not-configured";
  const turnstileDetail =
    intake.turnstile._tag === "NotConfigured"
      ? t("verification.intake.turnstileNotConfigured")
      : intake.turnstile._tag === "Skipped"
        ? t("verification.intake.turnstileServerSkipped")
        : intake.turnstile._tag === "Passed"
          ? t("verification.intake.turnstilePassed")
          : intake.turnstile._tag === "Unavailable"
            ? t(`verification.turnstileUnavailable.${intake.turnstile.source}`)
            : intake.turnstile.errorCodes !== undefined && intake.turnstile.errorCodes.length > 0
              ? t("verification.intake.turnstileFailedWithCodes", {
                  cause: t(`verification.turnstileCauses.${intake.turnstile.cause}`),
                  codes: intake.turnstile.errorCodes.join(", "),
                })
              : t(`verification.turnstileCauses.${intake.turnstile.cause}`);

  const repetitionTone: CheckTone = intake.repetition.outcome === "passed" ? "passed" : "failed";

  const blockedTone: CheckTone =
    intake.blockedTerm._tag === "Passed"
      ? "passed"
      : intake.blockedTerm._tag === "Failed"
        ? "failed"
        : "not-configured";
  const blockedDetail =
    intake.blockedTerm._tag === "NotConfigured"
      ? t("verification.intake.blockedNotConfigured")
      : intake.blockedTerm._tag === "Passed"
        ? t("verification.intake.blockedPassed")
        : t("verification.intake.blockedFailed", {
            term: intake.blockedTerm.term,
            scope: t(`verification.blockedScopes.${intake.blockedTerm.scope}`),
          });

  const quotaTone: CheckTone =
    intake.quota._tag === "Passed"
      ? "passed"
      : intake.quota._tag === "Failed"
        ? "failed"
        : "skipped";
  const quotaDetail =
    intake.quota._tag === "Skipped"
      ? t("verification.intake.quotaSkippedEarlier")
      : intake.quota._tag === "Passed"
        ? t("verification.intake.quotaPassed", {
            used: format.count(intake.quota.used),
            limit: format.count(intake.quota.limit),
          })
        : t("verification.intake.quotaFailed", {
            used: format.count(intake.quota.used),
            limit: format.count(intake.quota.limit),
          });

  return (
    <ul className="grid gap-1">
      <CheckRow
        tone={originTone}
        name={t("verification.intake.originName")}
        stateLabel={t(`verification.checkStates.${originTone}`)}
        detail={originDetail}
      />
      <CheckRow
        tone={honeypotTone}
        highlight={intake.decisiveReason === "honeypot"}
        name={t("verification.intake.honeypotName")}
        stateLabel={t(`verification.checkStates.${honeypotTone}`)}
        detail={honeypotDetail}
      />
      <CheckRow
        tone={turnstileTone}
        highlight={intake.decisiveReason === "turnstile-failed"}
        name={t("verification.intake.turnstileName")}
        stateLabel={t(
          `verification.checkStates.${turnstileTone === "warning" ? "unavailable" : turnstileTone}`,
        )}
        detail={turnstileDetail}
      />
      <CheckRow
        tone={repetitionTone}
        highlight={intake.decisiveReason === "repetition"}
        name={t("verification.intake.repetitionName")}
        stateLabel={t(`verification.checkStates.${repetitionTone}`)}
        detail={t("verification.intake.repetitionDetail", {
          senderCount: format.count(intake.repetition.priorSameSender),
          senderLimit: format.count(intake.repetition.senderThreshold),
          contentCount: format.count(intake.repetition.priorSameContent),
          contentLimit: format.count(intake.repetition.contentThreshold),
          days: format.count(intake.repetition.windowDays),
        })}
      />
      <CheckRow
        tone={blockedTone}
        highlight={intake.decisiveReason === "blocked-term"}
        name={t("verification.intake.blockedName")}
        stateLabel={t(`verification.checkStates.${blockedTone}`)}
        detail={blockedDetail}
      />
      <CheckRow
        tone={quotaTone}
        highlight={intake.decisiveReason === "quota"}
        name={t("verification.intake.quotaName")}
        stateLabel={t(`verification.checkStates.${quotaTone}`)}
        detail={quotaDetail}
      />
    </ul>
  );
}

function EscalationRow({
  escalation,
}: {
  readonly escalation: NonNullable<ReturnType<typeof evaluateClassificationChecks>["escalation"]>;
}) {
  const { t } = useTranslation();
  const format = useFormats();
  const classifier = formatClassifierName(t, escalation.classifier);

  if (escalation.status === "cleared") {
    return (
      <CheckRow
        tone="passed"
        name={t("verification.ai.escalationName", { classifier })}
        stateLabel={t("verification.ai.escalationClearedLabel")}
        detail={
          <span className="tabular-nums">
            {t("verification.ai.escalationClearedDetail", {
              spam: format.percent(escalation.scores.spam),
              solicitation:
                escalation.scores.solicitation === undefined
                  ? t("verification.ai.escalationNoScore")
                  : format.percent(escalation.scores.solicitation),
            })}
          </span>
        }
      />
    );
  }

  if (escalation.status === "confirmed") {
    return (
      <CheckRow
        tone="warning"
        name={t("verification.ai.escalationName", { classifier })}
        stateLabel={t("verification.ai.escalationConfirmedLabel")}
        detail={
          <span className="tabular-nums">
            {t("verification.ai.escalationConfirmedDetail", {
              reason: t(`status.reasons.${escalation.reason}`),
              spam: format.percent(escalation.scores.spam),
            })}
          </span>
        }
      />
    );
  }

  if (escalation.status === "skipped-quota") {
    return (
      <CheckRow
        tone="skipped"
        name={t("verification.ai.escalationName", { classifier })}
        stateLabel={t("verification.checkStates.skipped")}
        detail={t("verification.ai.escalationSkippedQuota")}
      />
    );
  }

  const failureKind = escalation.failure?.kind ?? "upstream-error";
  return (
    <CheckRow
      tone="warning"
      name={t("verification.ai.escalationName", { classifier })}
      stateLabel={t("verification.checkStates.failed")}
      detail={t("verification.ai.escalationFailedDetail", {
        reason: t(`verification.failures.${failureKind}`),
      })}
    />
  );
}

const previewBadgeVariants = {
  accepted: "success",
  quarantined: "warning",
  error: "destructive",
} as const satisfies Record<ScreeningPreview["outcome"], "success" | "warning" | "destructive">;

interface ScoredAnalysisViewProps {
  readonly scores: typeof ClassificationScores.Type;
  readonly policy: ClassificationPolicy | undefined;
  readonly classifier: ClassifierProvider | undefined;
  readonly escalation: typeof EscalationEvaluation.Type | undefined;
  readonly signals: ClassificationSignals | undefined;
  readonly attempts: number | undefined;
  readonly decisiveReason: typeof QuarantineReason.Type | null;
  readonly previousScores: typeof ClassificationScores.Type | undefined;
}

function ScoredAnalysisView({
  scores,
  policy,
  classifier,
  escalation,
  signals,
  attempts,
  decisiveReason,
  previousScores,
}: ScoredAnalysisViewProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const evaluated = evaluateClassificationChecks(
    scores,
    policy,
    classifier,
    escalation,
    decisiveReason,
  );
  const classifierName = formatClassifierName(t, classifier, scores.model);
  const spamTone: CheckTone =
    evaluated.spam.status === "passed" || evaluated.spam.status === "cleared"
      ? "passed"
      : evaluated.spam.status === "ambiguous"
        ? "warning"
        : "failed";
  const solicitationTone: CheckTone =
    evaluated.solicitation.status === "passed"
      ? "passed"
      : evaluated.solicitation.status === "failed"
        ? "failed"
        : "skipped";
  const relevanceTone: CheckTone =
    evaluated.relevance.status === "passed"
      ? "passed"
      : evaluated.relevance.status === "failed"
        ? "failed"
        : evaluated.relevance.status === "flagged"
          ? "warning"
          : "not-configured";

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 text-xs text-muted-foreground">
        <span>{t("verification.ai.evaluatedBy", { classifier: classifierName })}</span>
        {attempts !== undefined && attempts > 1 && (
          <span className="tabular-nums">
            {t("verification.ai.succeededOnAttempt", {
              attempt: format.count(attempts),
            })}
          </span>
        )}
      </div>
      <ul className="grid gap-1">
        <CheckRow
          tone={spamTone}
          highlight={evaluated.spam.decisive}
          name={t("verification.ai.spamName")}
          stateLabel={t(`verification.spamStates.${evaluated.spam.status}`)}
          detail={
            <div className="grid gap-1 tabular-nums">
              <span>
                {t("verification.ai.spamDetail", {
                  score: format.percent(evaluated.spam.score),
                  ambiguous: format.percent(evaluated.spam.ambiguousThreshold),
                  probable: format.percent(evaluated.spam.probableSpamThreshold),
                })}
                {previousScores !== undefined && (
                  <>
                    {" "}
                    <span className="text-foreground/70">
                      {t("verification.preview.wasScore", {
                        score: format.percent(previousScores.spam),
                      })}
                    </span>
                  </>
                )}
              </span>
              <ScoreBar
                score={evaluated.spam.score}
                tone={
                  spamTone === "failed" ? "failed" : spamTone === "warning" ? "warning" : "passed"
                }
                markers={[
                  { value: evaluated.spam.ambiguousThreshold },
                  { value: evaluated.spam.probableSpamThreshold, emphasis: true },
                ]}
              />
            </div>
          }
        />
        {evaluated.escalation !== null && <EscalationRow escalation={evaluated.escalation} />}
        <CheckRow
          tone={solicitationTone}
          highlight={evaluated.solicitation.decisive}
          name={t("verification.ai.solicitationName")}
          stateLabel={t(`verification.solicitationStates.${evaluated.solicitation.status}`)}
          detail={
            evaluated.solicitation.score === null ? (
              t("verification.ai.solicitationNotEvaluated")
            ) : (
              <div className="grid gap-1 tabular-nums">
                <span>
                  {t("verification.ai.solicitationDetail", {
                    score: format.percent(evaluated.solicitation.score),
                    threshold: format.percent(evaluated.solicitation.threshold),
                  })}
                  {previousScores?.solicitation !== undefined && (
                    <>
                      {" "}
                      <span className="text-foreground/70">
                        {t("verification.preview.wasScore", {
                          score: format.percent(previousScores.solicitation),
                        })}
                      </span>
                    </>
                  )}
                </span>
                <ScoreBar
                  score={evaluated.solicitation.score}
                  tone={solicitationTone === "failed" ? "failed" : "passed"}
                  markers={[{ value: evaluated.solicitation.threshold, emphasis: true }]}
                />
              </div>
            )
          }
        />
        <CheckRow
          tone={relevanceTone}
          highlight={evaluated.relevance.decisive}
          name={t("verification.ai.relevanceName")}
          stateLabel={t(`verification.relevanceStates.${evaluated.relevance.status}`)}
          detail={
            evaluated.relevance.score === null ? (
              t("verification.ai.relevanceNotConfigured")
            ) : (
              <div className="grid gap-1 tabular-nums">
                <span>
                  {t("verification.ai.relevanceDetail", {
                    score: format.percent(evaluated.relevance.score),
                    threshold: format.percent(evaluated.relevance.threshold),
                  })}
                  {previousScores?.relevance !== undefined && (
                    <>
                      {" "}
                      <span className="text-foreground/70">
                        {t("verification.preview.wasScore", {
                          score: format.percent(previousScores.relevance),
                        })}
                      </span>
                    </>
                  )}
                </span>
                <ScoreBar
                  score={evaluated.relevance.score}
                  tone={
                    relevanceTone === "failed"
                      ? "failed"
                      : relevanceTone === "warning"
                        ? "warning"
                        : "passed"
                  }
                  markers={[{ value: evaluated.relevance.threshold, emphasis: true }]}
                />
              </div>
            )
          }
        />
      </ul>
      {signals !== undefined &&
        (signals.urlOrHtmlOutsideLongestField || signals.senderMatchesOrganizationDomain) && (
          <div className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t("verification.ai.signalsTitle")}</p>
            <ul className="mt-1 grid gap-0.5">
              {signals.urlOrHtmlOutsideLongestField && (
                <li>{t("verification.ai.signalsUrlOrHtml")}</li>
              )}
              {signals.senderMatchesOrganizationDomain && (
                <li>{t("verification.ai.signalsOrganizationDomain")}</li>
              )}
            </ul>
          </div>
        )}
    </div>
  );
}

function ScreeningPreviewCard({
  preview,
  previousScores,
  onDismiss,
}: {
  readonly preview: ScreeningPreview;
  readonly previousScores: typeof ClassificationScores.Type | undefined;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const classifierName = formatClassifierName(t, preview.classifier, preview.scores?.model);

  let outcomeSummary: string;
  if (preview.outcome === "accepted") {
    outcomeSummary =
      preview.label === "off-topic"
        ? t("verification.preview.wouldAcceptOffTopic", { classifier: classifierName })
        : t("verification.preview.wouldAccept", { classifier: classifierName });
  } else if (preview.outcome === "error") {
    const kind = preview.failure?.kind ?? "upstream-error";
    outcomeSummary = t("verification.preview.wouldError", {
      reason: t(`verification.failures.${kind}`),
    });
  } else if (preview.blockedTerm._tag === "Failed") {
    outcomeSummary = t("verification.preview.wouldQuarantineBlockedTerm", {
      term: preview.blockedTerm.term,
      scope: t(`verification.blockedScopes.${preview.blockedTerm.scope}`),
    });
  } else {
    outcomeSummary = t("verification.preview.wouldQuarantineAi", {
      classifier: classifierName,
      reason:
        preview.reason === null
          ? t("inbox.statuses.quarantined")
          : t(`status.reasons.${preview.reason}`),
    });
  }

  const blockedTone: CheckTone =
    preview.blockedTerm._tag === "Passed"
      ? "passed"
      : preview.blockedTerm._tag === "Failed"
        ? "failed"
        : "not-configured";
  const blockedDetail =
    preview.blockedTerm._tag === "NotConfigured"
      ? t("verification.intake.blockedNotConfigured")
      : preview.blockedTerm._tag === "Passed"
        ? t("verification.intake.blockedPassed")
        : t("verification.intake.blockedFailed", {
            term: preview.blockedTerm.term,
            scope: t(`verification.blockedScopes.${preview.blockedTerm.scope}`),
          });

  return (
    <section
      aria-label={t("verification.preview.label")}
      className="grid gap-3 rounded-lg border border-border bg-muted/30 p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-xs font-semibold text-foreground">
            {t("verification.preview.title")}
          </h4>
          <Badge variant={previewBadgeVariants[preview.outcome]}>
            {t(`verification.previewBadges.${preview.outcome}`)}
          </Badge>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("verification.preview.dismiss")}
          onClick={onDismiss}
        >
          <X aria-hidden="true" className="size-3.5" />
        </Button>
      </div>

      <p className="text-sm text-pretty text-foreground">{outcomeSummary}</p>

      <ul className="grid gap-1">
        <CheckRow
          tone={blockedTone}
          highlight={preview.blockedTerm._tag === "Failed"}
          name={t("verification.intake.blockedName")}
          stateLabel={t(`verification.checkStates.${blockedTone}`)}
          detail={blockedDetail}
        />
      </ul>

      {preview.scores !== undefined && (
        <ScoredAnalysisView
          scores={preview.scores}
          policy={preview.policy}
          classifier={preview.classifier}
          escalation={preview.escalation}
          signals={preview.signals}
          attempts={1}
          decisiveReason={preview.outcome === "quarantined" ? preview.reason : null}
          previousScores={previousScores}
        />
      )}

      {preview.outcome === "error" && preview.failure !== undefined && (
        <p className="px-2.5 text-xs text-muted-foreground tabular-nums">
          {preview.failure.upstreamCode !== undefined
            ? t("verification.ai.failureMetaWithCode", {
                count: preview.failure.attempts,
                code: preview.failure.upstreamCode,
              })
            : t("verification.ai.failureMeta", { count: preview.failure.attempts })}
        </p>
      )}

      <div className="grid gap-1 border-t border-border/70 pt-2 text-xs text-pretty text-muted-foreground">
        <p>{t("verification.preview.dryRunNote")}</p>
        {preview.traceId !== null && (
          <p className="font-mono wrap-anywhere">
            {t("verification.preview.traceId")}: {preview.traceId}
          </p>
        )}
      </div>
    </section>
  );
}

function AiVerificationSection({
  entry,
  verification,
  outcomeEvent,
}: {
  readonly entry: InboxRow;
  readonly verification: SubmissionVerification;
  readonly outcomeEvent: ReturnType<typeof findLastClassificationOutcome>;
}) {
  const { t } = useTranslation();
  const format = useFormats();

  // Intake already stopped the submission before any AI classifier ran.
  if (verification.intakeReason !== null && outcomeEvent === undefined) {
    return (
      <ul className="grid gap-1">
        <CheckRow
          tone="skipped"
          name={t("verification.ai.skippedTitle")}
          stateLabel={t("verification.checkStates.skipped")}
          detail={t("verification.ai.skippedAtIntake")}
        />
      </ul>
    );
  }

  // Waiting in outbox or actively classifying.
  if (entry.status === "received" || entry.status === "classifying") {
    const stuckAt = verification.outbox?.stuckAt ?? null;
    const tone: CheckTone = stuckAt !== null ? "failed" : "pending";
    const detail =
      stuckAt !== null
        ? t("verification.ai.stuckDetail", {
            attempts: format.count(verification.outbox?.publicationCount ?? 12),
            date: format.timestamp(stuckAt),
          })
        : entry.status === "classifying"
          ? t("verification.ai.classifyingDetail")
          : t("verification.ai.queuedDetail");
    return (
      <ul className="grid gap-1">
        <CheckRow
          tone={tone}
          name={t("verification.ai.title")}
          stateLabel={t(`verification.checkStates.${stuckAt !== null ? "failed" : "pending"}`)}
          detail={detail}
        />
      </ul>
    );
  }

  const outcomeDetail = outcomeEvent?.detail;

  // Classification error recorded.
  if (
    outcomeDetail !== undefined &&
    outcomeDetail._tag === "SubmissionQuarantined" &&
    outcomeDetail.scores === undefined
  ) {
    const { failure, classifier } = outcomeDetail;
    const classifierName = classifier === undefined ? null : formatClassifierName(t, classifier);
    const kind = failure?.kind ?? "upstream-error";
    const failureText = t(`verification.failures.${kind}`);
    return (
      <ul className="grid gap-1">
        <CheckRow
          tone="failed"
          highlight
          name={
            classifierName !== null
              ? t("verification.ai.classifierRun", { classifier: classifierName })
              : t("verification.ai.title")
          }
          stateLabel={t("verification.checkStates.failed")}
          detail={
            <div className="grid gap-1">
              <p>{failureText}</p>
              {failure !== undefined && (
                <p className="tabular-nums">
                  {failure.upstreamCode !== undefined
                    ? t("verification.ai.failureMetaWithCode", {
                        count: failure.attempts,
                        code: failure.upstreamCode,
                      })
                    : t("verification.ai.failureMeta", { count: failure.attempts })}
                </p>
              )}
            </div>
          }
        />
      </ul>
    );
  }

  // Scored classification (either accepted automatically or quarantined by an AI rule,
  // even if a reviewer later accepted or archived the message).
  if (outcomeDetail !== undefined && outcomeDetail.scores !== undefined) {
    return (
      <ScoredAnalysisView
        scores={outcomeDetail.scores}
        policy={outcomeDetail.policy}
        classifier={outcomeDetail.classifier}
        escalation={outcomeDetail.escalation}
        signals={outcomeDetail.signals}
        attempts={outcomeDetail.attempts}
        decisiveReason={
          outcomeDetail._tag === "SubmissionQuarantined" ? outcomeDetail.reason : null
        }
        previousScores={undefined}
      />
    );
  }

  // Legacy message without stored classification events.
  return (
    <p className="px-2.5 text-xs text-pretty text-muted-foreground">
      {t("verification.ai.legacyNotice")}
    </p>
  );
}

function TimelineList({
  receivedAt,
  events,
}: {
  readonly receivedAt: number;
  readonly events: ReadonlyArray<SubmissionTimelineEvent>;
}) {
  const { t } = useTranslation();
  const format = useFormats();

  return (
    <div className="grid gap-1.5">
      <h4 className="text-xs font-medium text-muted-foreground">
        {t("verification.timeline.title")}
      </h4>
      <ol className="grid gap-1.5 border-l border-border pl-3 text-xs text-muted-foreground tabular-nums">
        <li>
          <span className="text-foreground">{t("verification.timeline.received")}</span>
          {" · "}
          <time dateTime={new Date(receivedAt).toISOString()}>{format.timestamp(receivedAt)}</time>
        </li>
        {events.map((event) => {
          const { detail } = event;
          let label: string;
          switch (detail._tag) {
            case "ClassificationRequested":
              label = t("verification.timeline.classificationStarted");
              break;
            case "ReclassificationRequested":
              label = t("verification.timeline.reclassificationRequested", {
                actor: formatActor(t, detail.actor),
              });
              break;
            case "SubmissionQuarantined":
              label = t("verification.timeline.quarantined", {
                reason: t(`status.reasons.${detail.reason}`),
              });
              break;
            case "SubmissionAccepted":
              label =
                detail.mode === "manual"
                  ? t("verification.timeline.acceptedManual", {
                      actor: formatActor(t, detail.actor),
                    })
                  : detail.label === "off-topic"
                    ? t("verification.timeline.acceptedAutomaticOffTopic", {
                        classifier: formatClassifierName(
                          t,
                          detail.classifier,
                          detail.scores?.model,
                        ),
                      })
                    : t("verification.timeline.acceptedAutomatic", {
                        classifier: formatClassifierName(
                          t,
                          detail.classifier,
                          detail.scores?.model,
                        ),
                      });
              break;
            case "SubmissionDismissed":
              label = t("verification.timeline.archived", {
                actor: formatActor(t, detail.actor),
              });
              break;
          }
          return (
            <li key={event.seq} className="wrap-anywhere">
              <span className="text-foreground">{label}</span>
              {" · "}
              <time dateTime={new Date(event.occurredAt).toISOString()}>
                {format.timestamp(event.occurredAt)}
              </time>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface MessageVerificationProps {
  readonly organizationId: string;
  readonly canTestScreening: boolean;
  readonly entry: InboxRow;
  readonly detail: SubmissionDetail | undefined;
  readonly loading: boolean;
}

type PreviewProblem = "quotaReached" | "failed";

/**
 * Detailed, plain-language explanation of why a message has its current status,
 * which intake and AI verifications passed, where it failed and why, plus
 * collapsible technical trace identifiers from Effect Observability and an
 * optional dry-run screening preview for users who can edit form/classification rules.
 */
export function MessageVerification({
  organizationId,
  canTestScreening,
  entry,
  detail,
  loading,
}: MessageVerificationProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const screeningTest = useMutation(testScreeningMutation(organizationId));
  const [previewState, setPreviewState] = useState<{
    readonly submissionId: string;
    readonly result: ScreeningPreview | null;
    readonly problem: PreviewProblem | null;
  } | null>(null);
  const [testingSubmissionId, setTestingSubmissionId] = useState<string | null>(null);
  const activePreview =
    previewState !== null && previewState.submissionId === entry.submissionId ? previewState : null;
  const testing = testingSubmissionId === entry.submissionId;

  async function runPreview() {
    const targetId = entry.submissionId;
    setTestingSubmissionId(targetId);
    try {
      const result = await screeningTest.mutateAsync(targetId);
      setPreviewState({ submissionId: targetId, result, problem: null });
    } catch (cause) {
      const problem: PreviewProblem = statusOf(cause) === 429 ? "quotaReached" : "failed";
      setPreviewState({ submissionId: targetId, result: null, problem });
    }
    setTestingSubmissionId((current) => (current === targetId ? null : current));
  }

  if (detail === undefined) {
    if (!loading) return null;
    return (
      <section aria-label={t("verification.label")} className="grid gap-3 hairline-t pt-5">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-10 w-full" />
      </section>
    );
  }

  const { verification } = detail;
  const acceptedEvent = findLastAccepted(verification.events);
  const dismissedEvent = findLastDismissed(verification.events);
  const quarantinedEvent = findLastQuarantined(verification.events);
  const classificationOutcome = findLastClassificationOutcome(verification.events);
  const badge = summaryBadgeOf(entry, verification, acceptedEvent);
  const latestTraceId = verification.events.at(-1)?.traceId ?? verification.intakeTraceId;
  const modelName =
    classificationOutcome !== undefined && classificationOutcome.detail.scores !== undefined
      ? classificationOutcome.detail.scores.model
      : null;
  const rulesVersion =
    classificationOutcome?.detail.rulesVersion ??
    (quarantinedEvent?.detail._tag === "SubmissionQuarantined"
      ? quarantinedEvent.detail.rulesVersion
      : null);

  let summaryText: string;
  if (entry.status === "accepted") {
    if (acceptedEvent?.detail.mode === "manual") {
      const priorReason =
        quarantinedEvent?.detail._tag === "SubmissionQuarantined"
          ? quarantinedEvent.detail.reason
          : verification.intakeReason;
      summaryText =
        priorReason !== null
          ? t("verification.summary.acceptedManualAfterQuarantine", {
              actor: formatActor(t, acceptedEvent.detail.actor),
              reason: t(`status.reasons.${priorReason}`),
            })
          : t("verification.summary.acceptedManual", {
              actor: formatActor(t, acceptedEvent.detail.actor),
            });
    } else if (acceptedEvent?.detail.scores !== undefined) {
      const classifier = formatClassifierName(
        t,
        acceptedEvent.detail.classifier,
        acceptedEvent.detail.scores.model,
      );
      summaryText =
        entry.label === "off-topic"
          ? t("verification.summary.acceptedAutomaticOffTopic", { classifier })
          : t("verification.summary.acceptedAutomatic", { classifier });
    } else {
      summaryText = t("verification.summary.acceptedGeneric");
    }
  } else if (entry.status === "archived") {
    const priorReason =
      quarantinedEvent?.detail._tag === "SubmissionQuarantined"
        ? quarantinedEvent.detail.reason
        : verification.intakeReason;
    summaryText =
      dismissedEvent !== undefined && priorReason !== null
        ? t("verification.summary.archivedAfterQuarantine", {
            actor: formatActor(t, dismissedEvent.detail.actor),
            reason: t(`status.reasons.${priorReason}`),
          })
        : dismissedEvent !== undefined
          ? t("verification.summary.archived", {
              actor: formatActor(t, dismissedEvent.detail.actor),
            })
          : t("verification.summary.archivedGeneric");
  } else if (entry.status === "received") {
    summaryText =
      verification.outbox?.stuckAt != null
        ? t("verification.summary.stuck", {
            attempts: format.count(verification.outbox.publicationCount),
          })
        : t("verification.summary.queued");
  } else if (entry.status === "classifying") {
    summaryText = t("verification.summary.analyzing");
  } else if (entry.reason === "repetition") {
    const senderCount =
      verification.intake?.repetition.priorSameSender ?? verification.priorSameSender;
    const contentCount =
      verification.intake?.repetition.priorSameContent ?? verification.priorSameContent;
    const senderLimit =
      verification.intake?.repetition.senderThreshold ?? repetitionThresholds.sender;
    const contentLimit =
      verification.intake?.repetition.contentThreshold ?? repetitionThresholds.content;
    const days = verification.intake?.repetition.windowDays ?? 30;
    const both = senderCount >= senderLimit && contentCount >= contentLimit;
    summaryText = both
      ? t("verification.summary.repetitionBoth", {
          senderCount: format.count(senderCount),
          senderLimit: format.count(senderLimit),
          contentCount: format.count(contentCount),
          contentLimit: format.count(contentLimit),
          days: format.count(days),
        })
      : contentCount >= contentLimit
        ? t("verification.summary.repetitionContent", {
            count: contentCount,
            limit: format.count(contentLimit),
            days: format.count(days),
          })
        : t("verification.summary.repetitionSender", {
            count: senderCount,
            limit: format.count(senderLimit),
            days: format.count(days),
          });
  } else if (entry.reason === "honeypot" && verification.intake?.honeypot._tag === "Failed") {
    summaryText = t("verification.summary.honeypot", {
      field: verification.intake.honeypot.field,
    });
  } else if (
    entry.reason === "blocked-term" &&
    verification.intake?.blockedTerm._tag === "Failed"
  ) {
    summaryText = t("verification.summary.blockedTerm", {
      term: verification.intake.blockedTerm.term,
      scope: t(`verification.blockedScopes.${verification.intake.blockedTerm.scope}`),
    });
  } else if (
    entry.reason === "turnstile-failed" &&
    verification.intake?.turnstile._tag === "Failed"
  ) {
    summaryText = t("verification.summary.turnstileFailed", {
      cause: t(`verification.turnstileCauses.${verification.intake.turnstile.cause}`),
    });
  } else if (entry.reason === "quota" && verification.intake?.quota._tag === "Failed") {
    summaryText = t("verification.summary.quota", {
      used: format.count(verification.intake.quota.used),
      limit: format.count(verification.intake.quota.limit),
    });
  } else if (
    entry.reason === "classification-error" &&
    classificationOutcome?.detail._tag === "SubmissionQuarantined" &&
    classificationOutcome.detail.failure !== undefined
  ) {
    summaryText = t("verification.summary.classificationError", {
      reason: t(`verification.failures.${classificationOutcome.detail.failure.kind}`),
    });
  } else if (
    entry.reason !== null &&
    classificationOutcome?.detail._tag === "SubmissionQuarantined" &&
    classificationOutcome.detail.scores !== undefined
  ) {
    const classifier = formatClassifierName(
      t,
      classificationOutcome.detail.classifier,
      classificationOutcome.detail.scores.model,
    );
    summaryText = t("verification.summary.quarantinedByAi", {
      classifier,
      reason: t(`status.reasons.${entry.reason}`),
    });
  } else if (entry.reason !== null) {
    summaryText = t("verification.summary.quarantinedGeneric", {
      reason: t(`status.reasons.${entry.reason}`),
    });
  } else {
    summaryText = t("verification.summary.generic");
  }

  return (
    <section aria-label={t("verification.label")} className="grid gap-4 hairline-t pt-5">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{t("verification.title")}</h3>
            <Badge variant={badgeVariants[badge]}>{t(`verification.badges.${badge}`)}</Badge>
          </div>
          {canTestScreening && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={testing}
              onClick={() => void runPreview()}
            >
              <FlaskConical aria-hidden="true" className="size-3.5" />
              {testing
                ? t("verification.preview.running")
                : activePreview?.result !== null && activePreview !== null
                  ? t("verification.preview.retest")
                  : t("verification.preview.action")}
            </Button>
          )}
        </div>
        <p className="text-sm text-pretty text-muted-foreground">{summaryText}</p>
      </div>

      {activePreview?.problem !== null && activePreview !== null && (
        <p role="alert" className="text-xs text-pretty text-destructive">
          {activePreview.problem === "quotaReached"
            ? t("verification.preview.quotaReached")
            : t("verification.preview.failed")}
        </p>
      )}

      {activePreview?.result !== null && activePreview !== null && (
        <ScreeningPreviewCard
          preview={activePreview.result}
          previousScores={classificationOutcome?.detail.scores}
          onDismiss={() => setPreviewState(null)}
        />
      )}

      <div className="grid gap-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">
          {t("verification.intake.title")}
        </h4>
        <IntakeChecksList intake={verification.intake} verification={verification} />
      </div>

      <div className="grid gap-1.5">
        <h4 className="text-xs font-medium text-muted-foreground">{t("verification.ai.title")}</h4>
        <AiVerificationSection
          entry={entry}
          verification={verification}
          outcomeEvent={classificationOutcome}
        />
      </div>

      {verification.events.length > 1 && (
        <TimelineList receivedAt={entry.receivedAt} events={verification.events} />
      )}

      <details className="group text-xs">
        <summary className="details-summary inline-flex cursor-pointer items-center gap-1 py-0.5 text-muted-foreground transition-colors duration-150 hover:text-foreground">
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
          />
          <span>{t("verification.technical.title")}</span>
        </summary>
        <dl className="mt-2 grid field-grid gap-x-4 gap-y-1.5 border-l border-border pl-3 text-xs text-muted-foreground">
          <div className="col-span-2 grid grid-cols-subgrid">
            <dt>{t("verification.technical.submissionId")}</dt>
            <dd className="font-mono wrap-anywhere text-foreground">{entry.submissionId}</dd>
          </div>
          {verification.intakeTraceId !== null && (
            <div className="col-span-2 grid grid-cols-subgrid">
              <dt>{t("verification.technical.intakeTrace")}</dt>
              <dd className="font-mono wrap-anywhere text-foreground">
                {verification.intakeTraceId}
              </dd>
            </div>
          )}
          {latestTraceId !== null && latestTraceId !== verification.intakeTraceId && (
            <div className="col-span-2 grid grid-cols-subgrid">
              <dt>{t("verification.technical.decisionTrace")}</dt>
              <dd className="font-mono wrap-anywhere text-foreground">{latestTraceId}</dd>
            </div>
          )}
          {modelName !== null && (
            <div className="col-span-2 grid grid-cols-subgrid">
              <dt>{t("verification.technical.model")}</dt>
              <dd className="font-mono wrap-anywhere text-foreground">{modelName}</dd>
            </div>
          )}
          {rulesVersion !== null && (
            <div className="col-span-2 grid grid-cols-subgrid">
              <dt>{t("verification.technical.rulesVersion")}</dt>
              <dd className="font-mono tabular-nums text-foreground">
                {t("verification.technical.rulesVersionValue", { version: rulesVersion })}
              </dd>
            </div>
          )}
          {verification.outbox?.handedOffAt != null && (
            <div className="col-span-2 grid grid-cols-subgrid">
              <dt>{t("verification.technical.handedOffAt")}</dt>
              <dd className="tabular-nums text-foreground">
                {format.timestamp(verification.outbox.handedOffAt)}
              </dd>
            </div>
          )}
        </dl>
      </details>
    </section>
  );
}
