import type { TFunction } from "i18next";

import type { ClassifierProvider } from "@rondyr/contracts/classification-policy";
import { repetitionThresholds, repetitionWindowDays } from "@rondyr/contracts/classifier-input";
import {
  evaluateClassificationChecks,
  type BlockedTermCheck,
  type EventActor,
  type ScreeningPreview,
  type SubmissionTimelineEvent,
} from "@rondyr/contracts/verification";

import type { InboxRow, SubmissionDetail } from "~/lib/api/messages";
import type { formats } from "~/lib/format";

type Formats = (typeof formats)[keyof typeof formats];

export type CheckKind =
  | "origin"
  | "honeypot"
  | "turnstile"
  | "sender"
  | "content"
  | "blocked"
  | "quota"
  | "spam"
  | "escalation"
  | "solicitation"
  | "relevance"
  | "classifier";

/**
 * fired: the check set the message aside, or would have. passed: it ran and found
 * nothing. off: not configured, not asked or not run. error: it could not finish.
 * unknown: the message arrived before the check was recorded.
 */
export type CheckState = "fired" | "passed" | "off" | "error" | "unknown";

/** A score between 0 and 1, the zones where its rule sets a message aside, and its thresholds. */
export interface Scale {
  readonly score: number;
  readonly zones: ReadonlyArray<{
    readonly from: number;
    readonly to: number;
    readonly strong: boolean;
  }>;
  readonly ticks: ReadonlyArray<number>;
}

export interface Check {
  readonly kind: CheckKind;
  readonly state: CheckState;
  readonly name: string;
  readonly value: string;
  /** Earlier messages against the threshold of a repetition check. */
  readonly count?: { readonly value: number; readonly threshold: number };
  readonly scale?: Scale;
}

export type VerdictTone = "flagged" | "error" | "accepted" | "pending" | "neutral";

/** Why the message is where it is, and the check that decided when one did. */
export interface Verdict {
  readonly tone: VerdictTone;
  readonly kind: CheckKind | null;
  readonly title: string;
  readonly detail: string;
}

export interface Screening {
  readonly verdict: Verdict;
  readonly intake: ReadonlyArray<Check>;
  /** The rules of the AI analysis that ran; empty when it did not run or left no scores. */
  readonly ai: ReadonlyArray<Check>;
  /** Why no AI rule has a score on arrival; null when they have one. */
  readonly aiMissing: "skipped" | "unrecorded" | "pending" | null;
  /** A line about the AI analysis: the classifier and its attempts, or why it has no scores. */
  readonly aiNote: string | null;
  readonly signals: ReadonlyArray<string>;
  readonly timeline: ReadonlyArray<{ readonly label: string; readonly at: number }>;
  readonly technical: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

export interface TestOutcome {
  readonly tone: "accepted" | "flagged" | "error";
  /** The test would move the message to another folder. */
  readonly changed: boolean;
  readonly summary: string;
  readonly notes: ReadonlyArray<string>;
  readonly blocked: Check;
  readonly ai: ReadonlyArray<Check>;
}

type Outcome = Extract<
  SubmissionTimelineEvent["detail"],
  { readonly _tag: "SubmissionAccepted" | "SubmissionQuarantined" }
>;

function classifierName(t: TFunction, classifier: ClassifierProvider | undefined) {
  return classifier === "openai" ? t("inbox.policy.models.openai") : t("inbox.policy.models.jev");
}

function actorName(t: TFunction, actor: EventActor | undefined) {
  if (actor === undefined) return t("verification.actors.unknown");
  if (actor._tag === "Reviewer") return actor.name ?? t("verification.actors.member");
  if (actor.name !== null && actor.suffix !== null) {
    return t("verification.actors.apiTokenNamed", { name: actor.name, suffix: actor.suffix });
  }
  if (actor.name !== null) return t("verification.actors.apiTokenOnlyName", { name: actor.name });
  return t("verification.actors.apiToken");
}

/** The last automatic decision of a classifier, with scores or with the reason it failed. */
function lastClassification(events: ReadonlyArray<SubmissionTimelineEvent>): Outcome | undefined {
  for (const { detail } of events.toReversed()) {
    if (
      detail._tag === "SubmissionAccepted" &&
      detail.mode === "automatic" &&
      detail.scores !== undefined
    ) {
      return detail;
    }
    if (
      detail._tag === "SubmissionQuarantined" &&
      (detail.scores !== undefined ||
        detail.failure !== undefined ||
        detail.reason === "classification-error")
    ) {
      return detail;
    }
  }
  return undefined;
}

function lastAccepted(events: ReadonlyArray<SubmissionTimelineEvent>) {
  for (const { detail } of events.toReversed()) {
    if (detail._tag === "SubmissionAccepted") return detail;
  }
  return undefined;
}

function lastDismissed(events: ReadonlyArray<SubmissionTimelineEvent>) {
  for (const { detail } of events.toReversed()) {
    if (detail._tag === "SubmissionDismissed") return detail;
  }
  return undefined;
}

function lastQuarantineReason(detail: SubmissionDetail) {
  for (const event of detail.verification.events.toReversed()) {
    if (event.detail._tag === "SubmissionQuarantined") return event.detail.reason;
  }
  return detail.verification.intakeReason;
}

function blockedCheck(t: TFunction, check: BlockedTermCheck): Check {
  const name = t("verification.checks.blocked.name");
  if (check._tag === "NotConfigured") {
    return {
      kind: "blocked",
      state: "off",
      name,
      value: t("verification.checks.blocked.notConfigured"),
    };
  }
  if (check._tag === "Passed") {
    return {
      kind: "blocked",
      state: "passed",
      name,
      value: t("verification.checks.blocked.passed"),
    };
  }
  return {
    kind: "blocked",
    state: "fired",
    name,
    value: t("verification.checks.blocked.found", { term: check.term }),
  };
}

/** The rules of one classification, each with its score on the scale of its thresholds. */
function aiChecksOf(
  t: TFunction,
  format: Formats,
  run: Pick<ScreeningPreview, "scores" | "policy" | "classifier" | "escalation"> & {
    readonly scores: NonNullable<ScreeningPreview["scores"]>;
  },
  decisiveReason: ScreeningPreview["reason"],
): Check[] {
  const { spam, escalation, solicitation, relevance } = evaluateClassificationChecks(
    run.scores,
    run.policy,
    run.classifier,
    run.escalation,
    decisiveReason,
  );
  const checks: Check[] = [
    {
      kind: "spam",
      state: spam.status === "failed" || spam.status === "ambiguous" ? "fired" : "passed",
      name: t("verification.checks.spam.name"),
      value: format.percent(spam.score),
      scale: {
        score: spam.score,
        zones: [
          { from: spam.ambiguousThreshold, to: spam.probableSpamThreshold, strong: false },
          { from: spam.probableSpamThreshold, to: 1, strong: true },
        ],
        ticks: [spam.ambiguousThreshold, spam.probableSpamThreshold],
      },
    },
  ];
  if (escalation !== null) {
    const name = t("verification.checks.escalation.name", {
      classifier: classifierName(t, escalation.classifier),
    });
    if (escalation.status === "cleared") {
      checks.push({
        kind: "escalation",
        state: "passed",
        name,
        value: t("verification.checks.escalation.cleared"),
      });
    } else if (escalation.status === "confirmed") {
      checks.push({
        kind: "escalation",
        state: "fired",
        name,
        value: t("verification.checks.escalation.confirmed"),
      });
    } else if (escalation.status === "skipped-quota") {
      checks.push({
        kind: "escalation",
        state: "off",
        name,
        value: t("verification.checks.escalation.skipped"),
      });
    } else {
      checks.push({
        kind: "escalation",
        state: "error",
        name,
        value: t("verification.checks.escalation.failed"),
      });
    }
  }
  checks.push(
    solicitation.score === null
      ? {
          kind: "solicitation",
          state: "off",
          name: t("verification.checks.solicitation.name"),
          value: t("verification.checks.solicitation.notEvaluated"),
        }
      : {
          kind: "solicitation",
          state: solicitation.status === "failed" ? "fired" : "passed",
          name: t("verification.checks.solicitation.name"),
          value: format.percent(solicitation.score),
          scale: {
            score: solicitation.score,
            zones: [{ from: solicitation.threshold, to: 1, strong: true }],
            ticks: [solicitation.threshold],
          },
        },
    relevance.score === null
      ? {
          kind: "relevance",
          state: "off",
          name: t("verification.checks.relevance.name"),
          value: t("verification.checks.relevance.notConfigured"),
        }
      : {
          kind: "relevance",
          state:
            relevance.status === "failed" || relevance.status === "flagged" ? "fired" : "passed",
          name: t("verification.checks.relevance.name"),
          value:
            relevance.status === "flagged"
              ? t("verification.checks.relevance.offTopic", {
                  score: format.percent(relevance.score),
                })
              : format.percent(relevance.score),
          scale: {
            score: relevance.score,
            zones: [{ from: 0, to: relevance.threshold, strong: true }],
            ticks: [relevance.threshold],
          },
        },
  );
  return checks;
}

/** The checks of the intake, in the order their reasons take precedence. */
function intakeChecksOf(t: TFunction, format: Formats, detail: SubmissionDetail): Check[] {
  const { intake, priorSameSender, priorSameContent } = detail.verification;
  const repetition = intake?.repetition ?? {
    priorSameSender,
    priorSameContent,
    senderThreshold: repetitionThresholds.sender,
    contentThreshold: repetitionThresholds.content,
  };
  const sender: Check = {
    kind: "sender",
    state: repetition.priorSameSender >= repetition.senderThreshold ? "fired" : "passed",
    name: t("verification.checks.sender.name"),
    value: t("verification.checks.repetitionValue", {
      value: format.count(repetition.priorSameSender),
      threshold: format.count(repetition.senderThreshold),
    }),
    count: { value: repetition.priorSameSender, threshold: repetition.senderThreshold },
  };
  const content: Check = {
    kind: "content",
    state: repetition.priorSameContent >= repetition.contentThreshold ? "fired" : "passed",
    name: t("verification.checks.content.name"),
    value: t("verification.checks.repetitionValue", {
      value: format.count(repetition.priorSameContent),
      threshold: format.count(repetition.contentThreshold),
    }),
    count: { value: repetition.priorSameContent, threshold: repetition.contentThreshold },
  };
  if (intake === null) {
    const unrecorded = t("verification.checks.unrecorded");
    return [
      {
        kind: "origin",
        state: "unknown",
        name: t("verification.checks.origin.name"),
        value: unrecorded,
      },
      {
        kind: "honeypot",
        state: "unknown",
        name: t("verification.checks.honeypot.name"),
        value: unrecorded,
      },
      {
        kind: "turnstile",
        state: "unknown",
        name: t("verification.checks.turnstile.name"),
        value: unrecorded,
      },
      sender,
      content,
      {
        kind: "blocked",
        state: "unknown",
        name: t("verification.checks.blocked.name"),
        value: unrecorded,
      },
      {
        kind: "quota",
        state: "unknown",
        name: t("verification.checks.quota.name"),
        value: unrecorded,
      },
    ];
  }

  const { origin, honeypot, turnstile, quota } = intake;
  const originName = t("verification.checks.origin.name");
  const honeypotName = t("verification.checks.honeypot.name");
  const turnstileName = t("verification.checks.turnstile.name");
  const quotaName = t("verification.checks.quota.name");
  return [
    origin._tag === "Skipped"
      ? {
          kind: "origin",
          state: "off",
          name: originName,
          value: t("verification.checks.origin.server"),
        }
      : {
          kind: "origin",
          state: "passed",
          name: originName,
          value:
            origin.mode === "unrestricted"
              ? t("verification.checks.origin.unrestricted")
              : origin.hasOrigin
                ? t("verification.checks.origin.allowed")
                : t("verification.checks.origin.noHeader"),
        },
    honeypot._tag === "NotConfigured"
      ? {
          kind: "honeypot",
          state: "off",
          name: honeypotName,
          value: t("verification.checks.honeypot.notConfigured"),
        }
      : honeypot._tag === "Passed"
        ? {
            kind: "honeypot",
            state: "passed",
            name: honeypotName,
            value: t("verification.checks.honeypot.empty"),
          }
        : {
            kind: "honeypot",
            state: "fired",
            name: honeypotName,
            value: t("verification.checks.honeypot.filled"),
          },
    turnstile._tag === "NotConfigured"
      ? {
          kind: "turnstile",
          state: "off",
          name: turnstileName,
          value: t("verification.checks.turnstile.notConfigured"),
        }
      : turnstile._tag === "Skipped"
        ? {
            kind: "turnstile",
            state: "off",
            name: turnstileName,
            value: t("verification.checks.turnstile.server"),
          }
        : turnstile._tag === "Passed"
          ? {
              kind: "turnstile",
              state: "passed",
              name: turnstileName,
              value: t("verification.checks.turnstile.passed"),
            }
          : turnstile._tag === "Unavailable"
            ? {
                kind: "turnstile",
                state: "passed",
                name: turnstileName,
                value: t("verification.checks.turnstile.unavailable"),
              }
            : {
                kind: "turnstile",
                state: "fired",
                name: turnstileName,
                value: t("verification.checks.turnstile.refused"),
              },
    sender,
    content,
    blockedCheck(t, intake.blockedTerm),
    quota._tag === "Passed"
      ? {
          kind: "quota",
          state: "passed",
          name: quotaName,
          value: t("verification.checks.quota.used", {
            used: format.count(quota.used),
            limit: format.count(quota.limit),
          }),
        }
      : quota._tag === "Failed"
        ? {
            kind: "quota",
            state: "fired",
            name: quotaName,
            value: t("verification.checks.quota.reached"),
          }
        : {
            kind: "quota",
            state: "off",
            name: quotaName,
            value: t("verification.checks.quota.notChecked"),
          },
  ];
}

function verdictOf(
  t: TFunction,
  format: Formats,
  entry: InboxRow,
  detail: SubmissionDetail,
  ai: ReadonlyArray<Check>,
  classification: Outcome | undefined,
): Verdict {
  const { verification } = detail;
  const classifier = classifierName(t, classification?.classifier);
  if (entry.status === "accepted") {
    const accepted = lastAccepted(verification.events);
    if (accepted?.mode === "manual") {
      const before = lastQuarantineReason(detail);
      return {
        tone: "accepted",
        kind: null,
        title: t("verification.verdicts.acceptedManual", { actor: actorName(t, accepted.actor) }),
        detail:
          before === null
            ? t("verification.verdicts.byHand")
            : t("verification.verdicts.byHandAfter", { reason: t(`status.reasons.${before}`) }),
      };
    }
    const relevance = ai.find((check) => check.kind === "relevance");
    return {
      tone: "accepted",
      kind: entry.label === "off-topic" ? "relevance" : null,
      title: t("verification.verdicts.acceptedAutomatic", { classifier }),
      detail:
        entry.label === "off-topic" && relevance?.scale !== undefined
          ? t("verification.verdicts.offTopic", { score: format.percent(relevance.scale.score) })
          : t("verification.verdicts.nothingFired"),
    };
  }
  if (entry.status === "archived") {
    const dismissed = lastDismissed(verification.events);
    const before = lastQuarantineReason(detail);
    return {
      tone: "neutral",
      kind: null,
      title:
        dismissed === undefined
          ? t("verification.verdicts.archivedGeneric")
          : t("verification.verdicts.archived", { actor: actorName(t, dismissed.actor) }),
      detail:
        before === null
          ? t("verification.verdicts.notDelivered")
          : t("verification.verdicts.archivedAfter", { reason: t(`status.reasons.${before}`) }),
    };
  }
  if (entry.status === "received") {
    const { outbox } = verification;
    return outbox?.stuckAt != null
      ? {
          tone: "error",
          kind: null,
          title: t("verification.verdicts.stuck"),
          detail: t("verification.verdicts.stuckDetail", { count: outbox.publicationCount }),
        }
      : {
          tone: "pending",
          kind: null,
          title: t("verification.verdicts.queued"),
          detail: t("verification.verdicts.queuedDetail"),
        };
  }
  if (entry.status === "classifying") {
    return {
      tone: "pending",
      kind: null,
      title: t("verification.verdicts.analyzing"),
      detail: t("verification.verdicts.analyzingDetail"),
    };
  }

  const { intake } = verification;
  const atIntake = t("verification.verdicts.atIntake");
  switch (entry.reason) {
    case "repetition": {
      const repetition = intake?.repetition;
      const days = repetition?.windowDays ?? repetitionWindowDays;
      const senderCount = repetition?.priorSameSender ?? verification.priorSameSender;
      const contentCount = repetition?.priorSameContent ?? verification.priorSameContent;
      const senderFired =
        senderCount >= (repetition?.senderThreshold ?? repetitionThresholds.sender);
      const contentFired =
        contentCount >= (repetition?.contentThreshold ?? repetitionThresholds.content);
      if (contentFired) {
        return {
          tone: "flagged",
          kind: "content",
          title: t("verification.verdicts.sameContent", {
            count: contentCount,
            days: format.count(days),
          }),
          detail: senderFired
            ? `${t("verification.verdicts.sameSenderToo", { count: senderCount })} ${atIntake}`
            : atIntake,
        };
      }
      return {
        tone: "flagged",
        kind: "sender",
        title: t("verification.verdicts.sameSender", {
          count: senderCount,
          days: format.count(days),
        }),
        detail: atIntake,
      };
    }
    case "honeypot":
      return {
        tone: "flagged",
        kind: "honeypot",
        title: t("verification.verdicts.honeypot"),
        detail:
          intake?.honeypot._tag === "Failed"
            ? t("verification.verdicts.honeypotDetail", { field: intake.honeypot.field })
            : atIntake,
      };
    case "turnstile-failed":
      return {
        tone: "flagged",
        kind: "turnstile",
        title: t("verification.verdicts.turnstile"),
        detail:
          intake?.turnstile._tag === "Failed"
            ? t(`verification.turnstileCauses.${intake.turnstile.cause}`)
            : atIntake,
      };
    case "blocked-term":
      return intake?.blockedTerm._tag === "Failed"
        ? {
            tone: "flagged",
            kind: "blocked",
            title: t("verification.verdicts.blockedTerm", { term: intake.blockedTerm.term }),
            detail: t("verification.verdicts.blockedTermDetail", {
              scope: t(`verification.blockedScopes.${intake.blockedTerm.scope}`),
            }),
          }
        : {
            tone: "flagged",
            kind: "blocked",
            title: t("status.reasons.blocked-term"),
            detail: atIntake,
          };
    case "quota":
      return {
        tone: "flagged",
        kind: "quota",
        title: t("verification.verdicts.quota"),
        detail:
          intake?.quota._tag === "Failed"
            ? t("verification.verdicts.quotaDetail", {
                used: format.count(intake.quota.used),
                limit: format.count(intake.quota.limit),
              })
            : t("verification.verdicts.waitsForYou"),
      };
    case "classification-error": {
      const failure =
        classification?._tag === "SubmissionQuarantined" ? classification.failure : undefined;
      const reason = t(`verification.failures.${failure?.kind ?? "upstream-error"}`);
      return {
        tone: "error",
        kind: "classifier",
        title: t("verification.verdicts.classificationError"),
        detail:
          failure === undefined
            ? t("verification.verdicts.classificationErrorDetail", { reason })
            : failure.upstreamCode === undefined
              ? t("verification.verdicts.classificationErrorAttempts", {
                  reason,
                  count: failure.attempts,
                })
              : t("verification.verdicts.classificationErrorCode", {
                  reason,
                  count: failure.attempts,
                  code: failure.upstreamCode,
                }),
      };
    }
    case null:
      return {
        tone: "flagged",
        kind: null,
        title: t("inbox.statuses.quarantined"),
        detail: t("verification.verdicts.waitsForYou"),
      };
    default: {
      const reason = t(`status.reasons.${entry.reason}`);
      if (classification?.scores === undefined) {
        return {
          tone: "flagged",
          kind: null,
          title: t("verification.verdicts.byAi", { reason }),
          detail: t("verification.verdicts.unrecordedScores"),
        };
      }
      const fired = ai.filter((check) => check.state === "fired");
      const decisiveKind =
        entry.reason === "ambiguous"
          ? ai.some((check) => check.kind === "escalation")
            ? "escalation"
            : "spam"
          : entry.reason === "solicitation"
            ? "solicitation"
            : entry.reason === "low-relevance"
              ? "relevance"
              : "spam";
      const decisive = ai.find((check) => check.kind === decisiveKind);
      const spam = ai.find((check) => check.kind === "spam");
      const others = fired.filter(
        (check) => check.kind !== decisiveKind && check.kind !== "spam",
      ).length;
      const also =
        others === 0 ? "" : ` ${t("verification.verdicts.otherRules", { count: others })}`;
      const score = decisive?.scale === undefined ? "" : format.percent(decisive.scale.score);
      const threshold = decisive?.scale?.ticks.at(-1);
      const titles = {
        "probable-spam": t("verification.verdicts.probableSpam", { classifier, score }),
        ambiguous: t("verification.verdicts.ambiguous", {
          classifier,
          score: spam === undefined ? "" : spam.value,
        }),
        solicitation: t("verification.verdicts.solicitation", { score }),
        "low-relevance": t("verification.verdicts.lowRelevance", { score }),
      } as const;
      const details = {
        "probable-spam": t("verification.verdicts.fromThreshold", {
          threshold: format.percent(threshold ?? 0),
        }),
        ambiguous:
          decisive?.kind === "escalation"
            ? t("verification.verdicts.secondOpinionKept", { name: decisive.name })
            : t("verification.verdicts.waitsForYou"),
        solicitation: t("verification.verdicts.aboveThreshold", {
          threshold: format.percent(threshold ?? 0),
        }),
        "low-relevance": t("verification.verdicts.belowMinimum", {
          threshold: format.percent(threshold ?? 0),
        }),
      } as const;
      return {
        tone: "flagged",
        kind: decisive?.kind ?? null,
        title: titles[entry.reason],
        detail: details[entry.reason] + also,
      };
    }
  }
}

/** What a reader needs to see of a message's screening, in the words of the interface. */
export function screeningOf(
  t: TFunction,
  format: Formats,
  entry: InboxRow,
  detail: SubmissionDetail,
): Screening {
  const { verification } = detail;
  const classification = lastClassification(verification.events);
  let ai: Check[] = [];
  let aiMissing: Screening["aiMissing"] = null;
  let aiNote: string | null = null;
  let signals: string[] = [];
  if (verification.intakeReason !== null && classification === undefined) {
    aiMissing = "skipped";
    aiNote = t("verification.ai.skipped");
  } else if (entry.status === "received" || entry.status === "classifying") {
    aiMissing = "pending";
    aiNote =
      entry.status === "classifying" ? t("verification.ai.analyzing") : t("verification.ai.queued");
  } else if (classification?.scores !== undefined) {
    ai = aiChecksOf(
      t,
      format,
      { ...classification, scores: classification.scores },
      classification._tag === "SubmissionQuarantined" ? classification.reason : null,
    );
    const name = classifierName(t, classification.classifier);
    aiNote =
      classification.attempts !== undefined && classification.attempts > 1
        ? t("verification.ai.byAfterAttempts", { classifier: name, count: classification.attempts })
        : name;
    const recorded = classification.signals;
    signals = [
      ...(recorded?.urlOrHtmlOutsideLongestField === true
        ? [t("verification.ai.signalLinks")]
        : []),
      ...(recorded?.senderMatchesOrganizationDomain === true
        ? [t("verification.ai.signalDomain")]
        : []),
    ];
  } else if (classification !== undefined) {
    const failure =
      classification._tag === "SubmissionQuarantined" ? classification.failure : undefined;
    ai = [
      {
        kind: "classifier",
        state: "error",
        name: classifierName(t, classification.classifier),
        value:
          failure?.kind === "timeout"
            ? t("verification.checks.classifier.timeout")
            : t("verification.checks.classifier.failed"),
      },
    ];
  } else {
    aiMissing = "unrecorded";
    aiNote = t("verification.ai.unrecorded");
  }

  const timeline: Array<{ label: string; at: number }> = [
    { label: t("verification.timeline.received"), at: entry.receivedAt },
  ];
  if (verification.intakeReason !== null) {
    timeline.push({
      label: t("verification.timeline.quarantinedAtIntake", {
        reason: t(`status.reasons.${verification.intakeReason}`),
      }),
      at: entry.receivedAt,
    });
  }
  for (const { detail: event, occurredAt } of verification.events) {
    let label: string;
    switch (event._tag) {
      case "ClassificationRequested":
        label = t("verification.timeline.classificationStarted");
        break;
      case "ReclassificationRequested":
        label = t("verification.timeline.reclassificationRequested", {
          actor: actorName(t, event.actor),
        });
        break;
      case "SubmissionQuarantined":
        label = t("verification.timeline.quarantined", {
          reason: t(`status.reasons.${event.reason}`),
        });
        break;
      case "SubmissionAccepted":
        label =
          event.mode === "manual"
            ? t("verification.timeline.acceptedManual", { actor: actorName(t, event.actor) })
            : event.label === "off-topic"
              ? t("verification.timeline.acceptedAutomaticOffTopic", {
                  classifier: classifierName(t, event.classifier),
                })
              : t("verification.timeline.acceptedAutomatic", {
                  classifier: classifierName(t, event.classifier),
                });
        break;
      case "SubmissionDismissed":
        label = t("verification.timeline.archived", { actor: actorName(t, event.actor) });
        break;
    }
    timeline.push({ label, at: occurredAt });
  }

  const lastQuarantine = verification.events.findLast(
    ({ detail: event }) => event._tag === "SubmissionQuarantined",
  )?.detail;
  const rulesVersion =
    classification?.rulesVersion ??
    (lastQuarantine?._tag === "SubmissionQuarantined" ? lastQuarantine.rulesVersion : undefined);
  const technical = [
    { name: t("verification.technical.submissionId"), value: entry.submissionId },
    ...(verification.intakeTraceId === null
      ? []
      : [{ name: t("verification.technical.intakeTrace"), value: verification.intakeTraceId }]),
    ...(classification?.scores === undefined
      ? []
      : [{ name: t("verification.technical.model"), value: classification.scores.model }]),
    ...(rulesVersion !== undefined
      ? [
          {
            name: t("verification.technical.rulesVersion"),
            value: t("verification.technical.rulesVersionValue", { version: rulesVersion }),
          },
        ]
      : []),
    ...(verification.outbox?.handedOffAt == null
      ? []
      : [
          {
            name: t("verification.technical.handedOffAt"),
            value: format.timestamp(verification.outbox.handedOffAt),
          },
        ]),
  ];

  return {
    verdict: verdictOf(t, format, entry, detail, ai, classification),
    intake: intakeChecksOf(t, format, detail),
    ai,
    aiMissing,
    aiNote,
    signals,
    timeline,
    technical,
  };
}

/** What a dry run of the current rules says, next to where the message is. */
export function testOutcomeOf(
  t: TFunction,
  format: Formats,
  entry: InboxRow,
  preview: ScreeningPreview,
): TestOutcome {
  const ai =
    preview.scores === undefined
      ? []
      : aiChecksOf(
          t,
          format,
          { ...preview, scores: preview.scores },
          preview.outcome === "quarantined" ? preview.reason : null,
        );
  const offTopic = preview.label === "off-topic";
  const wasAccepted = entry.status === "accepted";
  let tone: TestOutcome["tone"];
  let summary: string;
  if (preview.outcome === "accepted") {
    tone = "accepted";
    summary = wasAccepted
      ? offTopic
        ? t("verification.test.stillAcceptedOffTopic")
        : t("verification.test.stillAccepted")
      : offTopic
        ? t("verification.test.acceptedOffTopic")
        : t("verification.test.accepted");
  } else if (preview.outcome === "error") {
    tone = "error";
    summary = t("verification.test.error", {
      reason: t(`verification.failures.${preview.failure?.kind ?? "upstream-error"}`),
    });
  } else {
    tone = "flagged";
    const reason =
      preview.blockedTerm._tag === "Failed"
        ? t("verification.test.containsTerm", { term: preview.blockedTerm.term })
        : preview.reason === null
          ? t("inbox.statuses.quarantined")
          : t(`status.reasons.${preview.reason}`);
    summary =
      entry.status === "quarantined"
        ? t("verification.test.stillQuarantined", { reason })
        : t("verification.test.quarantined", { reason });
  }
  const intakeOnly =
    entry.reason === "repetition" ||
    entry.reason === "honeypot" ||
    entry.reason === "turnstile-failed" ||
    entry.reason === "quota";
  return {
    tone,
    changed: preview.outcome !== "error" && (preview.outcome === "accepted") !== wasAccepted,
    summary:
      preview.classifier === undefined
        ? summary
        : `${summary} · ${classifierName(t, preview.classifier)}`,
    notes: [
      ...(intakeOnly ? [t("verification.test.notRechecked")] : []),
      t("verification.test.dryRun"),
    ],
    blocked: blockedCheck(t, preview.blockedTerm),
    ai,
  };
}
