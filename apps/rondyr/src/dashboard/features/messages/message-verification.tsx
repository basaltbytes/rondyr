import { useMutation } from "@tanstack/react-query";
import { cn } from "cn";
import {
  ChevronRight,
  FlaskConical,
  Globe,
  LoaderCircle,
  RotateCw,
  Scale,
  X,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { ScreeningPreview } from "@rondyr/contracts/verification";

import { Button } from "~/components/ui/button";
import { reasonIcons } from "~/components/reason-label";
import { Skeleton } from "~/components/ui/skeleton";
import { testScreeningMutation, type InboxRow, type SubmissionDetail } from "~/lib/api/messages";
import { statusOf } from "~/lib/api/request";
import { useFormats } from "~/lib/i18n";

import {
  screeningOf,
  testOutcomeOf,
  type Check as ScreeningCheck,
  type CheckKind,
  type CheckState,
  type Scale as ScoreScale,
  type VerdictTone,
} from "./screening.ts";

/** The kind of a check is its icon; its color is only for a check that fired or failed. */
/**
 * The kind of a check is its icon, the same as the reason it gives a message in the list
 * and the reader. Its color is only for a check that fired or failed.
 */
const kindIcons = {
  origin: Globe,
  honeypot: reasonIcons.honeypot,
  turnstile: reasonIcons["turnstile-failed"],
  sender: reasonIcons.repetition,
  content: reasonIcons.repetition,
  blocked: reasonIcons["blocked-term"],
  quota: reasonIcons.quota,
  spam: reasonIcons["probable-spam"],
  escalation: Scale,
  solicitation: reasonIcons.solicitation,
  relevance: reasonIcons["low-relevance"],
  classifier: reasonIcons["classification-error"],
} as const satisfies Record<CheckKind, LucideIcon>;

const resultTones = {
  flagged: "text-warning",
  error: "text-destructive",
  accepted: "text-success",
  pending: "text-muted-foreground",
  neutral: "text-muted-foreground",
} as const satisfies Record<VerdictTone, string>;

const valueTones = {
  fired: "font-medium text-warning",
  error: "font-medium text-destructive",
  passed: "text-foreground",
  off: "text-muted-foreground",
  unknown: "text-muted-foreground",
} as const satisfies Record<CheckState, string>;

const iconTones = {
  fired: "text-warning",
  error: "text-destructive",
  passed: "text-muted-foreground",
  off: "text-muted-foreground",
  unknown: "text-muted-foreground",
} as const satisfies Record<CheckState, string>;

const at = (value: number) => `${(Math.max(0, Math.min(1, value)) * 100).toFixed(2)}%`;

/**
 * A score on its scale from 0 to 100 %. The hatched zone is where the rule sets a message
 * aside, so a rule that wants a high score and one that wants a low score read the same
 * way. A dot marks the score on arrival, a ring the score of a test. The SVG takes its
 * positions in percent of its width, so the dots stay round at any width.
 */
function ScoreMeter({
  scale,
  recorded,
  tested,
}: {
  readonly scale: ScoreScale;
  readonly recorded: number | null;
  readonly tested: number | undefined;
}) {
  const format = useFormats();
  const id = useId().replaceAll(/[^\w-]/gu, "");
  const inZone = (value: number) =>
    scale.zones.some(({ from, to }) => value >= from && value <= to);
  return (
    <svg aria-hidden="true" className="mt-1 mb-1 block h-8.5 w-full overflow-visible">
      <defs>
        <pattern
          id={`${id}-hatch`}
          patternUnits="userSpaceOnUse"
          width="4.5"
          height="4.5"
          patternTransform="rotate(45)"
        >
          <rect width="1.5" height="4.5" className="fill-warning" />
        </pattern>
        <clipPath id={`${id}-track`}>
          <rect y="4" width="100%" height="8" rx="4" />
        </clipPath>
      </defs>
      <rect y="4" width="100%" height="8" rx="4" className="fill-foreground/10" />
      <g clipPath={`url(#${id}-track)`}>
        {scale.zones.map((zone) => (
          <rect
            key={zone.from}
            x={at(zone.from)}
            y="4"
            width={at(zone.to - zone.from)}
            height="8"
            fill={`url(#${id}-hatch)`}
            className={zone.strong ? "opacity-70" : "opacity-35"}
          />
        ))}
      </g>
      {scale.ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={at(tick)}
            x2={at(tick)}
            y1="0"
            y2="16"
            strokeWidth="1"
            className="stroke-foreground/30"
          />
          <text
            x={at(tick)}
            y="30"
            textAnchor="middle"
            className="fill-muted-foreground text-xs tabular-nums"
          >
            {format.percent(tick)}
          </text>
        </g>
      ))}
      {recorded !== null && (
        <circle
          cx={at(recorded)}
          cy="8"
          r="6"
          strokeWidth="2"
          className={cn("stroke-background", inZone(recorded) ? "fill-warning" : "fill-foreground")}
        />
      )}
      {tested !== undefined && (
        <circle
          cx={at(tested)}
          cy="8"
          r="6"
          strokeWidth="2"
          className="animate-arrive fill-none stroke-foreground"
        />
      )}
    </svg>
  );
}

/** Earlier messages against the threshold of a repetition check: a full row is a stop. */
function RepetitionPips({
  value,
  threshold,
}: {
  readonly value: number;
  readonly threshold: number;
}) {
  const full = value >= threshold;
  return (
    <span aria-hidden="true" className="inline-flex gap-0.5">
      {Array.from({ length: threshold }, (_, index) => (
        <span
          key={index}
          className={cn(
            "h-1.5 w-3 rounded-full",
            index < value ? (full ? "bg-warning" : "bg-foreground/60") : "bg-foreground/15",
          )}
        />
      ))}
    </span>
  );
}

interface CheckRowProps {
  readonly check: ScreeningCheck;
  /** What the test found for this check; undefined when the test does not run it again. */
  readonly test: ScreeningCheck | undefined;
  readonly tested: boolean;
  /** The text of the arrival column when the check has no result of its own on arrival. */
  readonly missing?: string | undefined;
  readonly columns: number;
}

function CheckRow({ check, test, tested, missing, columns }: CheckRowProps) {
  const { t } = useTranslation();
  const Icon = kindIcons[check.kind];
  const scale = check.scale ?? test?.scale;
  return (
    <>
      <tr className={cn(scale === undefined && "border-b border-border/70")}>
        <th scope="row" className="py-2 pr-2 text-left align-top font-normal">
          <span className="flex items-center gap-2.5">
            <Icon aria-hidden="true" className={cn("size-4 shrink-0", iconTones[check.state])} />
            <span
              className={cn(
                "min-w-0",
                check.state === "off" || check.state === "unknown"
                  ? "text-muted-foreground"
                  : "text-foreground",
              )}
            >
              {check.name}
            </span>
          </span>
        </th>
        <td
          className={cn(
            "py-2 pl-3 text-right align-top tabular-nums",
            // A blocked phrase can be long; every other value is a word or a number.
            check.kind === "blocked" ? "text-pretty wrap-anywhere" : "whitespace-nowrap",
            missing === undefined ? valueTones[check.state] : "text-muted-foreground",
          )}
        >
          <span className="inline-flex items-center justify-end gap-2">
            {missing === undefined && check.count !== undefined && (
              <RepetitionPips value={check.count.value} threshold={check.count.threshold} />
            )}
            {missing ?? check.value}
          </span>
        </td>
        {tested &&
          (test === undefined ? (
            <td className="animate-arrive py-2 pr-1.5 pl-3 text-right align-top text-xs/5 whitespace-nowrap text-muted-foreground">
              {t("verification.test.notRetested")}
            </td>
          ) : (
            <td
              className={cn(
                "animate-arrive py-2 pr-1.5 pl-3 text-right align-top whitespace-nowrap tabular-nums",
                valueTones[test.state],
              )}
            >
              <span
                className={cn(
                  "-mx-1.5 rounded-full px-1.5 py-0.5",
                  missing === undefined &&
                    check.state !== "unknown" &&
                    test.value !== check.value &&
                    "bg-foreground/5",
                )}
              >
                {test.value}
              </span>
            </td>
          ))}
      </tr>
      {scale !== undefined && (
        <tr aria-hidden="true" className="border-b border-border/70">
          <td colSpan={columns} className="pr-0.5 pl-6.5">
            <ScoreMeter
              scale={scale}
              recorded={
                missing !== undefined || check.scale === undefined ? null : check.scale.score
              }
              tested={test?.scale?.score}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function GroupRow({
  label,
  aside,
  columns,
}: {
  readonly label: string;
  readonly aside?: ReactNode;
  readonly columns: number;
}) {
  return (
    <tr className="border-b border-border/70">
      <th
        scope="colgroup"
        colSpan={columns}
        className="pt-4 pb-1.5 text-left text-xs font-medium text-muted-foreground"
      >
        <span className="flex items-baseline justify-between gap-3">
          {label}
          {aside !== undefined && <span className="font-normal tabular-nums">{aside}</span>}
        </span>
      </th>
    </tr>
  );
}

interface MessageVerificationProps {
  readonly organizationId: string;
  readonly canTestScreening: boolean;
  readonly entry: InboxRow;
  readonly detail: SubmissionDetail | undefined;
  readonly loading: boolean;
}

type TestProblem = "quotaReached" | "failed";

interface TestState {
  readonly submissionId: string;
  readonly preview: ScreeningPreview | null;
  readonly problem: TestProblem | null;
  readonly at: number | null;
}

/**
 * How the screening treated a message: one sentence for why it is where it is, then
 * every check of the reception and of the AI analysis in one table. A test of the
 * current rules adds a column beside what happened on arrival, without changing the
 * message.
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
  // The reader keeps this component from one message to the next: a test belongs to its message.
  const [testState, setTestState] = useState<TestState | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const test = testState?.submissionId === entry.submissionId ? testState : null;
  const testing = testingId === entry.submissionId;

  async function runTest() {
    const submissionId = entry.submissionId;
    setTestingId(submissionId);
    try {
      const preview = await screeningTest.mutateAsync(submissionId);
      setTestState({ submissionId, preview, problem: null, at: Date.now() });
    } catch (cause) {
      const problem: TestProblem = statusOf(cause) === 429 ? "quotaReached" : "failed";
      setTestState((current) => ({
        submissionId,
        preview: current?.submissionId === submissionId ? current.preview : null,
        problem,
        at: current?.submissionId === submissionId ? current.at : null,
      }));
    }
    setTestingId((current) => (current === submissionId ? null : current));
  }

  if (detail === undefined) {
    if (!loading) return null;
    return (
      <section aria-label={t("verification.label")} className="grid gap-3 hairline-t pt-5">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-40 w-full" />
      </section>
    );
  }

  const screening = screeningOf(t, format, entry, detail);
  const outcome = test?.preview == null ? null : testOutcomeOf(t, format, entry, test.preview);
  const tested = outcome !== null;
  const columns = tested ? 3 : 2;
  const { verdict, intake, ai } = screening;
  const testOf = (check: ScreeningCheck) =>
    check.kind === "blocked"
      ? outcome?.blocked
      : outcome?.ai.find((other) => other.kind === check.kind);
  // Without a score on arrival, the AI rows are those of the test, beside why they had none.
  const aiRows = ai.length > 0 ? ai : (outcome?.ai ?? []);
  const missing =
    ai.length > 0
      ? undefined
      : screening.aiMissing === "skipped"
        ? t("verification.checks.notRun")
        : t("verification.checks.unrecorded");
  const resultLabel = (tone: VerdictTone) =>
    tone === "accepted"
      ? t("verification.results.accepted")
      : tone === "flagged"
        ? t("verification.results.quarantined")
        : tone === "error"
          ? t("verification.results.error")
          : tone === "pending"
            ? t("verification.results.pending")
            : t("verification.results.archived");
  const legend = tested && ai.length > 0 && outcome.ai.length > 0 && (
    <span className="inline-flex items-center gap-3">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="size-2 rounded-full bg-foreground" />
        {t("verification.test.legendRecorded")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="size-2 rounded-full border border-foreground" />
        {t("verification.test.legendTest")}
      </span>
    </span>
  );

  return (
    <section aria-label={t("verification.label")} className="grid gap-4 hairline-t pt-5">
      <div className="-my-1 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t("verification.title")}</h3>
        {canTestScreening && (
          <Button
            variant="ghost"
            size="sm"
            className="-mr-3"
            disabled={testing}
            onClick={() => void runTest()}
          >
            {testing ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-3.5 animate-spin motion-reduce:animate-none"
              />
            ) : tested ? (
              <RotateCw aria-hidden="true" className="size-3.5" />
            ) : (
              <FlaskConical aria-hidden="true" className="size-3.5" />
            )}
            {testing
              ? t("verification.test.running")
              : tested
                ? t("verification.test.retest")
                : t("verification.test.action")}
          </Button>
        )}
      </div>

      <p className="text-sm/relaxed text-pretty">
        <span className="font-medium wrap-anywhere">{verdict.title}.</span>{" "}
        <span className="text-muted-foreground">{verdict.detail}</span>
      </p>

      {test?.problem != null && (
        <p role="alert" className="animate-arrive text-sm text-pretty text-destructive">
          {test.problem === "quotaReached"
            ? t("verification.test.quotaReached")
            : t("verification.test.failed")}
        </p>
      )}

      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("verification.table.caption")}</caption>
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th scope="col" className="pb-1 text-left font-medium">
                {t("verification.table.check")}
              </th>
              <th scope="col" className="pb-1 pl-3 text-right font-medium whitespace-nowrap">
                {t("verification.table.onArrival")}
              </th>
              {tested && (
                <th
                  scope="col"
                  className="animate-arrive pb-1 pl-3 text-right font-medium whitespace-nowrap"
                >
                  <span className="inline-flex items-center gap-0.5">
                    {test?.at == null
                      ? t("verification.test.column")
                      : t("verification.test.columnAt", { time: format.timeOfDay(test.at) })}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="-my-2 -mr-2 size-7"
                      aria-label={t("verification.test.dismiss")}
                      onClick={() => setTestState(null)}
                    >
                      <X aria-hidden="true" className="size-3" />
                    </Button>
                  </span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            <GroupRow label={t("verification.table.intake")} columns={columns} />
            {intake.map((check) => (
              <CheckRow
                key={check.kind}
                check={check}
                test={check.kind === "blocked" ? outcome?.blocked : undefined}
                tested={tested}
                columns={columns}
              />
            ))}
          </tbody>
          <tbody>
            <GroupRow
              label={t("verification.table.ai")}
              aside={
                legend === false
                  ? ai.length > 0
                    ? (screening.aiNote ?? undefined)
                    : undefined
                  : legend
              }
              columns={columns}
            />
            {aiRows.length === 0 ? (
              <tr className="border-b border-border/70">
                <td colSpan={columns} className="py-2 pl-6.5 text-muted-foreground">
                  {screening.aiNote}
                </td>
              </tr>
            ) : (
              aiRows.map((check) => (
                <CheckRow
                  key={check.kind}
                  check={check}
                  test={ai.length > 0 ? testOf(check) : check}
                  tested={tested}
                  missing={missing}
                  columns={columns}
                />
              ))
            )}
          </tbody>
          {tested && (
            <tfoot>
              <tr>
                <th scope="row" className="pt-2.5 text-left font-medium">
                  {t("verification.table.result")}
                </th>
                <td
                  className={cn(
                    "pt-2.5 pl-3 text-right font-medium whitespace-nowrap",
                    resultTones[verdict.tone],
                  )}
                >
                  {resultLabel(verdict.tone)}
                </td>
                <td
                  className={cn(
                    "animate-arrive pt-2.5 pr-1.5 pl-3 text-right font-medium whitespace-nowrap",
                    resultTones[outcome.tone],
                  )}
                >
                  <span
                    className={cn(
                      "-mx-1.5 rounded-full px-1.5 py-0.5",
                      outcome.changed &&
                        (outcome.tone === "accepted" ? "bg-success-subtle" : "bg-warning-subtle"),
                    )}
                  >
                    {resultLabel(outcome.tone)}
                  </span>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {(tested || screening.signals.length > 0) && (
        <div className="grid gap-1 text-xs text-pretty text-muted-foreground">
          {tested && (
            <output className="block">
              <span className="text-foreground">{outcome.summary}.</span> {outcome.notes.join(" ")}
            </output>
          )}
          {screening.signals.length > 0 && (
            <p>{t("verification.ai.signals", { signals: screening.signals.join(" · ") })}</p>
          )}
        </div>
      )}

      <details className="group text-xs">
        <summary className="details-summary inline-flex cursor-pointer items-center gap-1 py-0.5 text-muted-foreground transition-colors duration-150 hover:text-foreground">
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
          />
          <span>{t("verification.technical.title")}</span>
        </summary>
        <div className="mt-2 grid gap-3 border-l border-border pl-3">
          <ol className="grid gap-1 text-muted-foreground tabular-nums">
            {screening.timeline.map(({ label, at: when }, index) => (
              <li key={index} className="wrap-anywhere">
                <span className="text-foreground">{label}</span>
                {" · "}
                <time dateTime={new Date(when).toISOString()}>{format.timestamp(when)}</time>
              </li>
            ))}
          </ol>
          <dl className="grid field-grid gap-x-4 gap-y-1.5 text-muted-foreground">
            {[
              ...screening.technical,
              ...(test?.preview?.traceId == null
                ? []
                : [{ name: t("verification.technical.testTrace"), value: test.preview.traceId }]),
            ].map(({ name, value }) => (
              <div key={name} className="col-span-2 grid grid-cols-subgrid">
                <dt>{name}</dt>
                <dd className="font-mono wrap-anywhere text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
    </section>
  );
}
