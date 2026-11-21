import { cn } from "cn";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { useFormats } from "~/lib/i18n";
import type { SubmissionEntry } from "~/lib/inbox-client";

import type { Folder } from "./folder-counts.ts";
import { excerptOf, listDay, senderOf, subjectOf } from "./message-preview.ts";

interface MessageRowProps {
  readonly submission: SubmissionEntry;
  readonly active: boolean;
  /** The status is shown where a folder mixes several of them. */
  readonly showStatus: boolean;
  readonly now: number;
  readonly onOpen: () => void;
}

function MessageRow({ submission, active, showStatus, now, onOpen }: MessageRowProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const sender = senderOf(submission.preview);
  const subject = subjectOf(submission.preview);
  const day = listDay(submission.receivedAt, now);
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onOpen}
      className={cn(
        "grid w-full grid-cols-1 gap-1 px-4 py-3 text-start transition-colors duration-150 ease-out",
        active ? "bg-accent" : "hover:bg-muted",
      )}
    >
      <span className="flex items-baseline justify-between gap-3">
        <span className="truncate text-sm font-medium">
          {sender.label ?? t("inbox.unknownSender")}
        </span>
        <time
          dateTime={new Date(submission.receivedAt).toISOString()}
          aria-label={format.longDateTime(submission.receivedAt)}
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {day === "today" && format.timeOfDay(submission.receivedAt)}
          {day === "yesterday" && t("inbox.list.yesterday")}
          {day === "earlier" && format.dayOfYear(submission.receivedAt)}
        </time>
      </span>
      <span className="line-clamp-2 text-sm wrap-anywhere text-muted-foreground">
        {subject !== null && <span className="text-foreground">{subject} · </span>}
        {excerptOf(submission.preview)}
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {submission.reason !== null && (
          <span className="shrink-0 font-medium text-warning">
            {t(`status.reasons.${submission.reason}`)}
          </span>
        )}
        {showStatus && submission.reason === null && (
          <span className="shrink-0">{t(`inbox.statuses.${submission.status}`)}</span>
        )}
        {submission.label === "off-topic" && (
          <span className="shrink-0">{t("inbox.offTopicLabel")}</span>
        )}
        <span className="truncate">{submission.formName}</span>
      </span>
    </button>
  );
}

interface MessageListProps {
  readonly folder: Folder;
  /** `null` while the first page loads. */
  readonly entries: readonly SubmissionEntry[] | null;
  /** The number of messages of the folder, when the counts are known. */
  readonly total: number | null;
  readonly selected: SubmissionEntry["submissionId"] | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly failed: boolean;
  /** When the list was read, to tell today's messages from older ones. */
  readonly now: number;
  /** Hidden on a narrow screen while a message is open. */
  readonly collapsed: boolean;
  readonly onOpen: (submission: SubmissionEntry) => void;
  readonly onMore: () => void;
  readonly onRefresh: () => void;
}

export function MessageList({
  folder,
  entries,
  total,
  selected,
  hasMore,
  loadingMore,
  failed,
  now,
  collapsed,
  onOpen,
  onMore,
  onRefresh,
}: MessageListProps) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("inbox.list.label")}
      className={cn("flex min-h-0 flex-col bg-card lg:hairline-r", collapsed && "max-lg:hidden")}
    >
      <header className="flex h-14 shrink-0 items-center gap-1 hairline-b px-1">
        <SidebarTrigger />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
          {t(`inbox.folders.${folder}`)}
          {total !== null && (
            <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
              {total}
            </span>
          )}
        </h1>
        <Button variant="ghost" size="icon" aria-label={t("common.refresh")} onClick={onRefresh}>
          <RefreshCw aria-hidden="true" className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        {failed && (
          <p role="alert" className="px-4 py-3 text-sm text-destructive">
            {t("inbox.list.loadFailed")}
          </p>
        )}
        {entries === null && !failed && (
          <output className="block px-4 py-3 text-sm text-muted-foreground">
            {t("inbox.list.loading")}
          </output>
        )}
        {entries?.length === 0 && (
          <div className="grid gap-2 px-4 py-10">
            <h2 className="text-base font-semibold text-balance">
              {t(`inbox.list.empty.${folder}.title`)}
            </h2>
            <p className="max-w-prose text-sm text-pretty text-muted-foreground">
              {t(`inbox.list.empty.${folder}.note`)}
            </p>
          </div>
        )}
        {entries !== null && entries.length > 0 && (
          <ul>
            {entries.map((submission) => (
              <li key={submission.submissionId} className="hairline-b">
                <MessageRow
                  submission={submission}
                  active={submission.submissionId === selected}
                  showStatus={folder === "all"}
                  now={now}
                  onOpen={() => onOpen(submission)}
                />
              </li>
            ))}
          </ul>
        )}
        {hasMore && (
          <div className="p-4">
            <Button disabled={loadingMore} onClick={onMore}>
              {loadingMore ? t("inbox.list.loadingMore") : t("inbox.list.more")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
