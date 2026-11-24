import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "cn";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useActionState, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { findMatchedBlockedTerm } from "@rondyr/forms/blocked-term";
import { allows } from "@rondyr/organizations/member-role";

import { ErrorBoundary } from "~/components/error-boundary";
import { FormEmoji } from "~/components/form-emoji";
import { ReadFailure } from "~/components/read-failure";
import { FormProblem } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { blockedTermsQuery, organizationBlockedTermsQuery } from "~/lib/api/blocked-terms";
import {
  applyDecision,
  deleteMessageMutation,
  messageCountsQuery,
  messageListQuery,
  messageQuery,
  reviewMessageMutation,
  type DecidedFrom,
} from "~/lib/api/messages";
import type { Organization } from "~/lib/api/organizations";
import { statusOf } from "~/lib/api/request";
import { countsOfForm, totalOf } from "~/lib/folder-counts";
import { useFormats } from "~/lib/i18n";
import type { MessagesSearch } from "~/lib/messages-search";

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

/** Why a decision was not applied. Each one names a message of `inbox.reader.problems`. */
type DecisionProblem =
  | "notSaved"
  | "alreadyHandled"
  | "alreadyHandledRefresh"
  | "classificationQuotaReached";

const isDecision = (value: FormDataEntryValue | null) =>
  value === "approve" || value === "dismiss" || value === "reclassify";

interface MessageReaderProps {
  readonly organization: Organization;
  readonly submissionId: string;
  /** The folder, the form and the text of the list beside the reader. */
  readonly search: MessagesSearch;
  /**
   * Opens another message, or the list alone with null. After a decision or a deletion
   * the address of the message that left replaces itself.
   */
  readonly onOpen: (submissionId: string | null, replace: boolean) => void;
}

interface DeletionProps {
  readonly organizationId: Organization["id"];
  readonly message: DecidedFrom;
  readonly onDeleted: () => void;
}

/**
 * Deletes the message for good, after a confirmation in the page: a browser
 * dialog would let a page of another origin answer for the person.
 */
function Deletion({ organizationId, message, onDeleted }: DeletionProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const deletion = useMutation(deleteMessageMutation(organizationId));
  const [failed, remove, removing] = useActionState(async () => {
    try {
      await deletion.mutateAsync(message);
    } catch {
      return true;
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

/** Placeholder matching the reader toolbar and message layout while a message loads. */
export function MessageReaderSkeleton() {
  const { t } = useTranslation();
  return (
    <>
      <output className="sr-only">{t("common.loading")}</output>
      <div
        aria-hidden="true"
        className="flex h-14 shrink-0 items-center justify-between gap-2 hairline-b px-4"
      >
        <div className="flex items-center gap-1.5">
          <Skeleton className="size-7" />
          <Skeleton className="size-7" />
          <Skeleton className="h-3.5 w-16" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-28" />
        </div>
      </div>
      <div aria-hidden="true" className="min-h-0 flex-1 lg:overflow-y-auto">
        <div className="grid max-w-3xl gap-6 px-5 pt-6 pb-10">
          <div className="grid gap-2.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-6 w-56 max-w-full" />
            <Skeleton className="h-3.5 w-44 max-w-full" />
          </div>
          <div className="grid max-w-prose gap-2.5">
            <Skeleton className="h-4 w-48 max-w-full" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
          <div className="grid gap-2.5 hairline-t pt-5">
            <div className="flex items-center gap-6">
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3.5 w-44" />
            </div>
            <div className="flex items-center gap-6">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3.5 w-52" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * One message. The bar on top has the place of the message in the list and the
 * decision, at the height of the list's header. Under it everything starts on
 * one left edge: why the message is here, who wrote, what they wrote, then the
 * other fields. A message opened by its address shows even when the list does not
 * have it.
 */
export function MessageReader({ organization, submissionId, search, onOpen }: MessageReaderProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const queryClient = useQueryClient();
  const organizationId = organization.id;
  // MessageList owns keeping the list fresh; opening a message must not refetch every page.
  const list = useInfiniteQuery({
    ...messageListQuery(organizationId, search),
    refetchOnMount: false,
  });
  const { data: counts } = useQuery(messageCountsQuery(organizationId));
  // A list entry has long values cut short. The decision does not wait for the full ones.
  const detail = useQuery(messageQuery(organizationId, submissionId));
  const review = useMutation(reviewMessageMutation(organizationId));
  const entries = list.data?.pages.flatMap((page) => page.entries) ?? [];
  const index = entries.findIndex((entry) => entry.submissionId === submissionId);
  const listed = entries[index];
  const above = index < 0 ? undefined : entries[index - 1];
  const below = index < 0 ? undefined : entries[index + 1];
  const entry = detail.data ?? listed;
  const checkBlockedTerms = entry?.reason === "blocked-term";
  const formBlockedTerms = useQuery({
    ...blockedTermsQuery(organizationId, entry?.formPublicId ?? ""),
    enabled: checkBlockedTerms && allows(organization.role, "manage-forms") && entry !== undefined,
  });
  const orgBlockedTerms = useQuery({
    ...organizationBlockedTermsQuery(organizationId),
    enabled: checkBlockedTerms && allows(organization.role, "manage-settings"),
  });
  const inFolder = counts === undefined ? null : totalOf(counts, search.folder);
  const inForm =
    counts === undefined || search.form === undefined
      ? inFolder
      : totalOf(countsOfForm(counts, search.form), search.folder);
  const total = (search.q === undefined ? inForm : null) ?? entries.length;
  const position = index < 0 ? null : index + 1;

  /** The message left the folder: the next one opens, like in a mail client. */
  function openNext() {
    onOpen((below ?? above)?.submissionId ?? null, true);
  }

  /** After a decision, the message leaves a folder other than All. */
  function decided() {
    if (search.folder !== "all") openNext();
  }

  const [problem, decide, pending] = useActionState(
    async (_: DecisionProblem | null, form: FormData): Promise<DecisionProblem | null> => {
      const decision = form.get("decision");
      if (entry === undefined || !isDecision(decision)) return null;
      try {
        await review.mutateAsync({ message: entry, decision });
        decided();
        return null;
      } catch (cause) {
        // Reclassify takes a slot of the organization's daily classification quota.
        if (statusOf(cause) === 429) return "classificationQuotaReached";
        if (statusOf(cause) !== 409) return "notSaved";
        try {
          const current = await queryClient.query({
            ...messageQuery(organizationId, submissionId),
            staleTime: 0,
          });
          applyDecision(queryClient, organizationId, entry, current);
          decided();
        } catch {
          return "alreadyHandledRefresh";
        }
        return "alreadyHandled";
      }
    },
    null,
  );

  if (entry === undefined) {
    return detail.isError ? (
      <ReadFailure
        className="px-5 py-6"
        cause={detail.error}
        title={t("inbox.reader.loadFailed")}
        retry={t("common.retry")}
        retrying={detail.isFetching}
        onRetry={() => void detail.refetch()}
      />
    ) : (
      <MessageReaderSkeleton />
    );
  }

  const fields = detail.data?.fields ?? listed?.preview ?? {};
  const matchedTerm =
    entry.reason === "blocked-term"
      ? findMatchedBlockedTerm(fields, [
          ...(formBlockedTerms.data ?? []).map(({ term }) => term),
          ...(orgBlockedTerms.data ?? []).map(({ term }) => term),
        ])
      : null;
  const detailFailed = detail.isError;
  const fromForm =
    organization.forms.length > 1
      ? organization.forms.find(({ publicId }) => publicId === entry.formPublicId)
      : undefined;
  const mayDelete = allows(organization.role, "delete-submissions");
  const mayRetry = allows(organization.role, "retry-deliveries");
  const onClose = () => onOpen(null, false);
  const onPrevious = above === undefined ? null : () => onOpen(above.submissionId, false);
  const onNext = below === undefined ? null : () => onOpen(below.submissionId, false);
  const { sender, subject, body, details } = readMessage(fields);
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
          <Deletion organizationId={organization.id} message={entry} onDeleted={openNext} />
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
              {matchedTerm !== null && (
                <span className="ml-2 font-normal wrap-anywhere text-muted-foreground">
                  {t("inbox.reader.matchedTerm", { term: matchedTerm })}
                </span>
              )}
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
              <Button size="sm" disabled={detail.isFetching} onClick={() => void detail.refetch()}>
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
            <ErrorBoundary variant="section">
              <DeliveryHistory
                organizationId={organization.id}
                submissionId={submissionId}
                canRetry={mayRetry}
              />
            </ErrorBoundary>
          )}
        </article>
      </div>
    </>
  );
}
