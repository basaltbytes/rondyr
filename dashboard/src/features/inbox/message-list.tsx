import { cn } from "cn";
import { RefreshCw } from "lucide-react";

import { Button } from "~/components/ui/button";
import { SidebarTrigger } from "~/components/ui/sidebar";
import type { Submission } from "~/lib/inbox-client";
import { reviewReasons } from "~/lib/status-labels";

import type { Folder } from "./inbox-sidebar.tsx";
import { excerptOf, fullTime, listTime, senderOf, subjectOf } from "./message-preview.ts";
import { folderLabels, statusLabels } from "./strings.ts";

const emptyFolders = {
  quarantined: [
    "Rien à vérifier",
    "Les messages que le filtre met de côté apparaissent ici, en attendant votre décision.",
  ],
  accepted: [
    "Aucun message",
    "Les messages acceptés, par le filtre ou par vous, apparaissent ici.",
  ],
  archived: ["Aucun message", "Les messages que vous archivez apparaissent ici."],
  all: [
    "Aucun message reçu",
    "Les messages envoyés depuis vos formulaires arrivent ici. L’adresse de chaque formulaire est dans Formulaires.",
  ],
} as const;

interface MessageRowProps {
  readonly submission: Submission;
  readonly active: boolean;
  /** The status is shown where a folder mixes several of them. */
  readonly showStatus: boolean;
  readonly now: number;
  readonly onOpen: () => void;
}

function MessageRow({ submission, active, showStatus, now, onOpen }: MessageRowProps) {
  const sender = senderOf(submission.fields);
  const subject = subjectOf(submission.fields);
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
        <span className="truncate text-sm font-medium">{sender.label ?? "Expéditeur inconnu"}</span>
        <time
          dateTime={new Date(submission.receivedAt).toISOString()}
          aria-label={fullTime(submission.receivedAt)}
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
        >
          {listTime(submission.receivedAt, now)}
        </time>
      </span>
      <span className="line-clamp-2 text-sm wrap-anywhere text-muted-foreground">
        {subject !== null && <span className="text-foreground">{subject} · </span>}
        {excerptOf(submission.fields)}
      </span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {submission.reason !== null && (
          <span className="shrink-0 font-medium text-warning">
            {reviewReasons[submission.reason]}
          </span>
        )}
        {showStatus && submission.reason === null && (
          <span className="shrink-0">{statusLabels[submission.status]}</span>
        )}
        <span className="truncate">{submission.formName}</span>
      </span>
    </button>
  );
}

interface MessageListProps {
  readonly folder: Folder;
  /** `null` while the first page loads. */
  readonly entries: readonly Submission[] | null;
  /** The number of messages of the folder, when the counts are known. */
  readonly total: number | null;
  readonly selected: Submission["submissionId"] | null;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly failed: boolean;
  /** When the list was read, to tell today's messages from older ones. */
  readonly now: number;
  /** Hidden on a narrow screen while a message is open. */
  readonly collapsed: boolean;
  readonly onOpen: (submission: Submission) => void;
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
  const [emptyTitle, emptyNote] = emptyFolders[folder];
  return (
    <section
      aria-label="Liste des messages"
      className={cn("flex min-h-0 flex-col bg-card lg:hairline-r", collapsed && "max-lg:hidden")}
    >
      <header className="flex h-14 shrink-0 items-center gap-1 hairline-b px-1">
        <SidebarTrigger />
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">
          {folderLabels[folder]}
          {total !== null && (
            <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
              {total}
            </span>
          )}
        </h1>
        <Button variant="ghost" size="icon" aria-label="Actualiser" onClick={onRefresh}>
          <RefreshCw aria-hidden="true" className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        {failed && (
          <p role="alert" className="px-4 py-3 text-sm text-destructive">
            Impossible de charger les messages.
          </p>
        )}
        {entries === null && !failed && (
          <output className="block px-4 py-3 text-sm text-muted-foreground">
            Chargement des messages…
          </output>
        )}
        {entries?.length === 0 && (
          <div className="grid gap-2 px-4 py-10">
            <h2 className="text-base font-semibold text-balance">{emptyTitle}</h2>
            <p className="max-w-prose text-sm text-pretty text-muted-foreground">{emptyNote}</p>
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
              {loadingMore ? "Chargement…" : "Afficher les messages suivants"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
