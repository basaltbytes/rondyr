import { AlertDialog } from "@base-ui/react/alert-dialog";
import { cn } from "cn";
import { Schema } from "effect";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useFormats } from "~/lib/i18n";
import { FormProblem } from "~/components/text-field";
import {
  deleteSubmission,
  getSubmission,
  InboxRequestError,
  reviewSubmission,
} from "~/lib/inbox-client";
import type { Inbox, Submission, SubmissionEntry } from "~/lib/inbox-client";

import { FormEmoji } from "./form-emoji.tsx";
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
type DecisionProblem =
  | "notSaved"
  | "alreadyHandled"
  | "alreadyHandledRefresh"
  | "classificationQuotaReached";

interface SubmissionReaderProps {
  readonly inboxId: Inbox["id"];
  /** The message as the list has it. Its preview is shown until the full fields arrive. */
  readonly entry: SubmissionEntry;
  /** The form of the message, when its emoji tells it apart from the other forms. */
  readonly fromForm: Inbox["forms"][number] | undefined;
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
  /** Whether the role of the account allows deleting the message. */
  readonly mayDelete: boolean;
  /** Whether the role of the account allows retrying a failed delivery. */
  readonly mayRetry: boolean;
  /** The message was deleted for good. */
  readonly onDeleted: () => void;
}

interface DeletionProps {
  readonly inboxId: Inbox["id"];
  readonly submissionId: Submission["submissionId"];
  readonly onDeleted: () => void;
}

/**
 * Deletes the message for good, after a confirmation in the page: a browser
 * dialog would let a page of another origin answer for the person.
 */
function Deletion({ inboxId, submissionId, onDeleted }: DeletionProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [failed, remove, removing] = useActionState(async () => {
    try {
      await deleteSubmission(inboxId, submissionId);
    } catch (error) {
      // Another admin deleted it first: it is gone either way.
      if (!isRequestError(error) || error.status !== 404) return true;
    }
    setConfirming(false);
    onDeleted();
    return false;
  }, false);

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={trigger}
              variant="ghost"
              size="icon-sm"
              aria-label={t("inbox.reader.delete.action")}
              onClick={() => setConfirming(true)}
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          }
        />
        <TooltipContent side="bottom">{t("inbox.reader.delete.action")}</TooltipContent>
      </Tooltip>
      <AlertDialog.Root
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !removing) setConfirming(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
          <AlertDialog.Popup
            finalFocus={trigger}
            className="fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-2rem)] max-w-sm -translate-1/2 gap-3 rounded-lg border bg-card p-5 text-foreground shadow-popover outline-hidden"
          >
            <AlertDialog.Title className="text-base font-semibold">
              {t("inbox.reader.delete.title")}
            </AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-pretty text-muted-foreground">
              {t("inbox.reader.delete.description")}
            </AlertDialog.Description>
            <form action={remove} className="grid gap-2">
              <div className="flex flex-wrap justify-end gap-2">
                <AlertDialog.Close disabled={removing} render={<Button variant="ghost" />}>
                  {t("common.cancel")}
                </AlertDialog.Close>
                <Button type="submit" variant="default" disabled={removing}>
                  {removing ? t("inbox.reader.delete.deleting") : t("inbox.reader.delete.confirm")}
                </Button>
              </div>
              <FormProblem>{failed ? t("inbox.reader.delete.failed") : null}</FormProblem>
            </form>
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
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
  fromForm,
  revision,
  position,
  total,
  onPrevious,
  onNext,
  onReviewed,
  onClose,
  mayDelete,
  mayRetry,
  onDeleted,
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
        // Reclassify takes a slot of the organization's daily classification quota.
        if (isRequestError(error) && error.status === 429) return "classificationQuotaReached";
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
      <header className="@container flex h-14 shrink-0 items-center gap-1.5 hairline-b px-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("inbox.reader.back")}
          className="lg:hidden"
          onClick={onClose}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </Button>
        {position !== null && (
          // A narrow pane keeps its width for the decision.
          <div className="hidden shrink-0 items-center gap-0.5 @sm:flex">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("inbox.reader.previous")}
              disabled={onPrevious === null}
              onClick={onPrevious ?? undefined}
            >
              <ChevronUp aria-hidden="true" className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("inbox.reader.next")}
              disabled={onNext === null}
              onClick={onNext ?? undefined}
            >
              <ChevronDown aria-hidden="true" className="size-4" />
            </Button>
            <p className="hidden px-1.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums @md:block">
              {t("inbox.reader.position", {
                position: format.count(position),
                total: format.count(Math.max(position, total)),
              })}
            </p>
          </div>
        )}
        <span className="flex-1" />
        {mayDelete && (
          <Deletion inboxId={inboxId} submissionId={submissionId} onDeleted={onDeleted} />
        )}
        {mayDelete && entry.status === "quarantined" && (
          <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
        )}
        {entry.status === "quarantined" && (
          <form action={decide} className="flex shrink-0 items-center gap-2">
            {entry.reason === "classification-error" && (
              // Only a message the filter could not analyze can go back to it.
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="submit"
                      size="sm"
                      name="decision"
                      value="reclassify"
                      disabled={pending}
                    >
                      <RotateCw aria-hidden="true" className="size-3.5" />
                      <span className="@max-2xl:sr-only">{t("inbox.reader.reclassify")}</span>
                    </Button>
                  }
                />
                <TooltipContent side="bottom">{t("inbox.reader.reclassify")}</TooltipContent>
              </Tooltip>
            )}
            <Button type="submit" size="sm" name="decision" value="dismiss" disabled={pending}>
              <Archive aria-hidden="true" className="size-3.5" />
              {t("inbox.reader.archive")}
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              name="decision"
              value="approve"
              disabled={pending}
            >
              <Check aria-hidden="true" className="size-3.5" />
              <span className="@lg:hidden">{t("inbox.reader.accept")}</span>
              <span className="hidden @lg:inline">{t("inbox.reader.acceptAndSend")}</span>
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
            <p className="flex flex-wrap items-center gap-x-1.5 text-xs wrap-anywhere text-muted-foreground">
              {fromForm !== undefined && <FormEmoji form={fromForm} className="text-sm" />}
              <span>
                {entry.formName} ·{" "}
                <time dateTime={new Date(entry.receivedAt).toISOString()} className="tabular-nums">
                  {format.longDateTime(entry.receivedAt)}
                </time>
              </span>
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
            <DeliveryHistory
              inboxId={inboxId}
              submissionId={submissionId}
              revision={revision}
              canRetry={mayRetry}
            />
          )}
        </article>
      </div>
    </>
  );
}
