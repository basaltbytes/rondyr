import { cn } from "cn";
import { Schema } from "effect";
import { Archive, Check, ChevronDown, ChevronLeft, ChevronUp, RotateCw } from "lucide-react";
import { useActionState, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import { useFormats } from "~/lib/i18n";
import { getSubmission, InboxRequestError, reviewSubmission } from "~/lib/inbox-client";
import type { Inbox, Submission, SubmissionEntry } from "~/lib/inbox-client";

import { DeliveryHistory } from "./delivery-history.tsx";
import { readMessage } from "./message-preview.ts";

// Color is the status of the message, and nothing else in the reader has one.
const statusTones = {
  received: "text-muted-foreground",
  classifying: "text-muted-foreground",
  accepted: "text-success",
  quarantined: "text-warning",
  archived: "text-muted-foreground",
} as const;

const isRequestError = Schema.is(InboxRequestError);

/** Why a decision was not applied. Each one names a message of `inbox.reader.problems`. */
type DecisionProblem = "notSaved" | "alreadyHandled" | "alreadyHandledRefresh";

interface SubmissionReaderProps {
  readonly inboxId: Inbox["id"];
  /** The message as the list has it. Its preview is shown until the full fields arrive. */
  readonly entry: SubmissionEntry;
  readonly revision: number;
  /** The place of the message in the list, from 1, or null when the list does not have it. */
  readonly position: number | null;
  /** How many messages the folder has. */
  readonly total: number;
  /** Opens the message before this one in the list, if there is one. */
  readonly onPrevious: (() => void) | null;
  /** Opens the message after this one in the list, if there is one. */
  readonly onNext: (() => void) | null;
  /** The message as the API returns it once it is accepted, archived or sent back to the filter. */
  readonly onReviewed: (submission: Submission) => void;
  readonly onClose: () => void;
}

/**
 * One message. The bar on top has the place of the message in the list and the
 * decision, at the height of the list's header. Under it everything starts on
 * one left edge: why the message is here, who wrote, what they wrote, then the
 * other fields.
 */
export function SubmissionReader({
  inboxId,
  entry,
  revision,
  position,
  total,
  onPrevious,
  onNext,
  onReviewed,
  onClose,
}: SubmissionReaderProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const { submissionId } = entry;
  const [detail, setDetail] = useState<Submission | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [detailRequests, setDetailRequests] = useState(0);

  // A list entry has long values cut short. The decision does not wait for the full ones.
  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the full fields of the open message from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void getSubmission(inboxId, submissionId, request.signal).then(setDetail, () => {
      if (!request.signal.aborted) setDetailFailed(true);
    });
    return () => request.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A retry initiates a new API request.
  }, [inboxId, submissionId, detailRequests]);

  const [problem, decide, pending] = useActionState(
    async (_: DecisionProblem | null, form: FormData): Promise<DecisionProblem | null> => {
      const decision = form.get("decision");
      if (decision !== "approve" && decision !== "dismiss" && decision !== "reclassify") {
        return null;
      }
      try {
        onReviewed(await reviewSubmission(inboxId, submissionId, decision));
        return null;
      } catch (error) {
        if (!isRequestError(error) || error.status !== 409) return "notSaved";
        try {
          onReviewed(await getSubmission(inboxId, submissionId, new AbortController().signal));
        } catch {
          return "alreadyHandledRefresh";
        }
        return "alreadyHandled";
      }
    },
    null,
  );

  const { sender, subject, body, details } = readMessage(detail?.fields ?? entry.preview);
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-2 hairline-b pr-5 pl-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("inbox.reader.back")}
          className="lg:hidden"
          onClick={onClose}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </Button>
        {position !== null && (
          // A narrow screen keeps its width for the decision.
          <div className="flex items-center max-sm:hidden">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("inbox.reader.previous")}
              disabled={onPrevious === null}
              onClick={onPrevious ?? undefined}
            >
              <ChevronUp aria-hidden="true" className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("inbox.reader.next")}
              disabled={onNext === null}
              onClick={onNext ?? undefined}
            >
              <ChevronDown aria-hidden="true" className="size-4" />
            </Button>
            <p className="px-2 text-xs text-muted-foreground tabular-nums">
              {t("inbox.reader.position", {
                position: format.count(position),
                total: format.count(Math.max(position, total)),
              })}
            </p>
          </div>
        )}
        {entry.status === "quarantined" && (
          <form action={decide} className="ml-auto flex gap-2">
            {entry.reason === "classification-error" && (
              // Only a message the filter could not analyze can go back to it.
              <Button type="submit" name="decision" value="reclassify" disabled={pending}>
                <RotateCw aria-hidden="true" className="size-4" />
                <span className="max-sm:sr-only">{t("inbox.reader.reclassify")}</span>
              </Button>
            )}
            <Button type="submit" name="decision" value="dismiss" disabled={pending}>
              <Archive aria-hidden="true" className="size-4" />
              {t("inbox.reader.archive")}
            </Button>
            <Button
              type="submit"
              variant="default"
              name="decision"
              value="approve"
              disabled={pending}
            >
              <Check aria-hidden="true" className="size-4" />
              <span className="sm:hidden">{t("inbox.reader.accept")}</span>
              <span className="max-sm:hidden">{t("inbox.reader.acceptAndSend")}</span>
            </Button>
          </form>
        )}
      </header>
      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        <article className="grid max-w-3xl gap-6 px-5 pt-6 pb-10">
          <header className="grid gap-2">
            <p className={cn("text-sm font-medium", statusTones[entry.status])}>
              {entry.reason === null
                ? t(`inbox.statuses.${entry.status}`)
                : t(`status.reasons.${entry.reason}`)}
              {entry.label === "off-topic" && (
                <span className="ml-2 font-normal text-muted-foreground">
                  {t("inbox.offTopicLabel")}
                </span>
              )}
            </p>
            <div>
              <h2 className="text-xl/snug font-semibold wrap-anywhere">
                {sender.label ?? t("inbox.unknownSender")}
              </h2>
              {sender.name !== null && sender.email !== null && (
                <p className="text-sm wrap-anywhere text-muted-foreground">{sender.email}</p>
              )}
            </div>
            <p className="text-xs wrap-anywhere text-muted-foreground">
              {entry.formName} ·{" "}
              <time dateTime={new Date(entry.receivedAt).toISOString()} className="tabular-nums">
                {format.longDateTime(entry.receivedAt)}
              </time>
            </p>
          </header>
          {problem !== null && (
            <p role="alert" className="text-sm text-destructive">
              {t(`inbox.reader.problems.${problem}`)}
            </p>
          )}
          {detailFailed && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p role="alert" className="text-sm text-pretty text-destructive">
                {t("inbox.reader.detail.loadFailed")}
              </p>
              <Button
                size="sm"
                onClick={() => {
                  setDetailFailed(false);
                  setDetailRequests((value) => value + 1);
                }}
              >
                {t("inbox.reader.detail.retry")}
              </Button>
            </div>
          )}
          {(entry.status === "received" || entry.status === "classifying") && (
            <p className="text-sm text-muted-foreground">{t("inbox.reader.analyzing")}</p>
          )}
          {(subject !== null || body !== null) && (
            <div className="grid max-w-prose gap-2">
              {subject !== null && (
                <h3 className="text-base font-semibold wrap-anywhere">{subject}</h3>
              )}
              {body !== null && (
                <p className="text-base/relaxed wrap-anywhere whitespace-pre-wrap">{body}</p>
              )}
            </div>
          )}
          {details.length > 0 && (
            <dl className="grid field-grid gap-x-6 gap-y-2 hairline-t pt-5 text-sm">
              {details.map(([name, value]) => (
                <div key={name} className="col-span-2 grid grid-cols-subgrid">
                  <dt className="font-mono text-xs leading-5 wrap-anywhere text-muted-foreground">
                    {name}
                  </dt>
                  <dd className="wrap-anywhere whitespace-pre-wrap">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {entry.status === "accepted" && (
            <DeliveryHistory inboxId={inboxId} submissionId={submissionId} revision={revision} />
          )}
        </article>
      </div>
    </>
  );
}
