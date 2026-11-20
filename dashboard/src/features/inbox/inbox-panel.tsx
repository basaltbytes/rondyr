import { cn } from "cn";
import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/components/ui/sidebar";
import { countSubmissions, listInboxes, listSubmissions } from "~/lib/inbox-client";
import type { Counts, Inbox, Submission, SubmissionEntry } from "~/lib/inbox-client";
import { productName } from "~/lib/product";

import { InboxSetup } from "./inbox-setup.tsx";
import { countsAfterMove, totalOf } from "./folder-counts.ts";
import type { Folder } from "./folder-counts.ts";
import { InboxSidebar } from "./inbox-sidebar.tsx";
import type { Section } from "./inbox-sidebar.tsx";
import { MessageList } from "./message-list.tsx";
import { SubmissionReader } from "./submission-reader.tsx";

// The settings are not part of the first paint, so their code loads when one of them opens.
const InboxSettings = lazy(async () => {
  const { InboxSettings: Settings } = await import("./inbox-settings.tsx");
  return { default: Settings };
});

/**
 * Holds the place of a page while its code loads. It has the bar and the menu
 * button that every page starts with, so nothing moves when the page arrives.
 */
function PageFallback() {
  const { t } = useTranslation();
  return (
    <div className="min-w-0 lg:col-span-2">
      <div className="flex h-14 items-center px-1">
        <SidebarTrigger />
      </div>
      <output className="sr-only">{t("common.loading")}</output>
    </div>
  );
}

interface Listing {
  readonly entries: readonly SubmissionEntry[];
  readonly cursor: string | null;
  /** When the first page was read. */
  readonly readAt: number;
}

interface InboxViewProps {
  readonly inboxes: readonly Inbox[];
  readonly inbox: Inbox;
  readonly account: ReactNode;
  /** The page of the processing status, which another feature owns. */
  readonly operations: ReactNode;
  readonly onInbox: (id: string) => void;
  /** Reload the organizations after a change to their forms. */
  readonly onFormsChanged: () => Promise<void>;
  readonly onOrganizationCreated: () => void;
}

function InboxView({
  inboxes,
  inbox,
  account,
  operations,
  onInbox,
  onFormsChanged,
  onOrganizationCreated,
}: InboxViewProps) {
  const { t } = useTranslation();
  const [folder, setFolder] = useState<Folder>("quarantined");
  const [section, setSection] = useState<Section | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [opened, setOpened] = useState<SubmissionEntry | null>(null);
  const [revision, setRevision] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const status = folder === "all" ? "" : folder;

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Synchronizes the list of messages with the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listSubmissions(inbox.id, status, null, request.signal).then(
      ({ entries, cursor }) => {
        setFailed(false);
        setListing({ entries, cursor, readAt: Date.now() });
      },
      () => {
        if (!request.signal.aborted) setFailed(true);
      },
    );
    return () => request.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A refresh initiates a new API request. A decision changes the list without one.
  }, [inbox.id, status, revision]);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Synchronizes the folder counts with the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    // The folders work without their counts, so a failure leaves the last known ones.
    void countSubmissions(inbox.id, request.signal).then(setCounts, () => undefined);
    return () => request.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A refresh initiates a new API request. A decision changes the counts without one.
  }, [inbox.id, revision]);

  // The row of the list has the latest status of the open message.
  const index =
    opened === null || listing === null
      ? -1
      : listing.entries.findIndex((entry) => entry.submissionId === opened.submissionId);
  const current = listing?.entries[index] ?? opened;
  const above = listing?.entries[index - 1];
  const below = index < 0 ? undefined : listing?.entries[index + 1];
  const total = counts === null ? null : totalOf(counts, folder);

  function openFolder(next: Folder) {
    setSection(null);
    setOpened(null);
    if (next === folder) return;
    setFolder(next);
    setListing(null);
    setFailed(false);
  }

  async function loadMore() {
    if (listing === null || listing.cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await listSubmissions(
        inbox.id,
        status,
        listing.cursor,
        new AbortController().signal,
      );
      setListing({
        ...listing,
        entries: [...listing.entries, ...page.entries],
        cursor: page.cursor,
      });
    } catch {
      setFailed(true);
    }
    setLoadingMore(false);
  }

  function reviewed(updated: Submission) {
    if (listing !== null) {
      const at = listing.entries.findIndex((entry) => entry.submissionId === updated.submissionId);
      const before = listing.entries[at];
      if (before !== undefined) {
        // The API counts every message of the organization, so the counts follow the decision here.
        setCounts((known) =>
          known === null ? null : countsAfterMove(known, before.status, updated.status),
        );
      }
      if (folder === "all") {
        // The row keeps its preview and takes the new status.
        const decided = (entry: SubmissionEntry) =>
          entry === before ? { ...entry, status: updated.status, reason: updated.reason } : entry;
        setListing({ ...listing, entries: listing.entries.map(decided) });
      } else {
        // Like a mail client: the decided message leaves the folder and the next one opens.
        const entries = listing.entries.filter((entry) => entry !== before);
        setListing({ ...listing, entries });
        setOpened(entries[at] ?? entries[at - 1] ?? null);
      }
    }
  }

  return (
    <SidebarProvider className="lg:h-dvh lg:overflow-hidden">
      <InboxSidebar
        inboxes={inboxes}
        inbox={inbox}
        counts={counts}
        folder={folder}
        section={section}
        account={account}
        onInbox={onInbox}
        onFolder={openFolder}
        onSection={(next) => {
          setSection(next);
          setOpened(null);
        }}
      />
      <SidebarInset className="lg:grid lg:h-dvh lg:inbox-panes">
        {section === null ? (
          <>
            <MessageList
              folder={folder}
              entries={listing?.entries ?? null}
              total={total}
              selected={current?.submissionId ?? null}
              hasMore={listing !== null && listing.cursor !== null}
              loadingMore={loadingMore}
              failed={failed}
              now={listing?.readAt ?? 0}
              collapsed={current !== null}
              onOpen={setOpened}
              onMore={() => void loadMore()}
              onRefresh={() => setRevision((value) => value + 1)}
            />
            <section
              aria-label={t("inbox.reader.label")}
              className={cn(
                "flex min-h-0 min-w-0 flex-col bg-card",
                current === null && "max-lg:hidden",
              )}
            >
              {current === null ? (
                <ReaderPlaceholder waiting={counts?.quarantined ?? null} />
              ) : (
                <SubmissionReader
                  key={current.submissionId}
                  inboxId={inbox.id}
                  entry={current}
                  revision={revision}
                  position={index < 0 ? null : index + 1}
                  total={total ?? listing?.entries.length ?? 0}
                  onPrevious={above === undefined ? null : () => setOpened(above)}
                  onNext={below === undefined ? null : () => setOpened(below)}
                  onReviewed={reviewed}
                  onClose={() => setOpened(null)}
                />
              )}
            </section>
          </>
        ) : (
          <Suspense fallback={<PageFallback />}>
            {section === "operations" ? (
              operations
            ) : (
              <InboxSettings
                section={section}
                inbox={inbox}
                onFormsChanged={onFormsChanged}
                onOrganizationCreated={onOrganizationCreated}
              />
            )}
          </Suspense>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}

interface ReaderPlaceholderProps {
  /** How many messages wait for a decision, when the counts are known. */
  readonly waiting: number | null;
}

function ReaderPlaceholder({ waiting }: ReaderPlaceholderProps) {
  const { t } = useTranslation();
  return (
    <>
      {/* The rule under the list's header continues across the empty reader. */}
      <div className="h-14 shrink-0 hairline-b" />
      {waiting !== null && (
        <div className="grid gap-2 px-5 py-6">
          <h2 className="text-base font-semibold text-balance">
            {waiting === 0 ? t("inbox.reader.nothingToReview") : t("inbox.reader.noOpenMessage")}
          </h2>
          <p className="max-w-prose text-pretty text-muted-foreground">
            {t("inbox.reader.waiting", { count: waiting })}
          </p>
        </div>
      )}
    </>
  );
}

interface InboxPanelProps {
  /** The signed-in account and its menu, shown at the foot of the sidebar. */
  readonly account: ReactNode;
  /** A sign-out button for the first run, which has no sidebar. */
  readonly signOut: ReactNode;
  /** The page of the processing status, opened from the sidebar. */
  readonly operations: ReactNode;
}

export function InboxPanel({ account, signOut, operations }: InboxPanelProps) {
  const { t } = useTranslation();
  const [inboxes, setInboxes] = useState<readonly Inbox[] | null>(null);
  const [active, setActive] = useState("");
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the signed-in user's organizations from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listInboxes(request.signal).then(setInboxes, () => {
      if (!request.signal.aborted) setFailed(true);
    });
    return () => request.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Creating a new inbox initiates a new API request.
  }, [revision]);

  async function reload() {
    try {
      setInboxes(await listInboxes());
    } catch {
      setFailed(true);
    }
  }

  function created() {
    setFailed(false);
    setRevision((value) => value + 1);
  }

  const inbox = inboxes?.find(({ id }) => id === active) ?? inboxes?.[0];
  if (inbox !== undefined && inboxes !== null) {
    return (
      <InboxView
        key={inbox.id}
        inboxes={inboxes}
        inbox={inbox}
        account={account}
        operations={operations}
        onInbox={setActive}
        onFormsChanged={reload}
        onOrganizationCreated={created}
      />
    );
  }

  return (
    <main className="mx-auto grid max-w-xl gap-5 px-5 py-12">
      <h1 className="text-lg font-semibold">{productName}</h1>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          {t("inbox.organizations.loadFailed")}
        </p>
      )}
      {inboxes === null && !failed && (
        <output className="text-sm text-muted-foreground">
          {t("inbox.organizations.loading")}
        </output>
      )}
      {inboxes !== null && <InboxSetup onCreated={created} />}
      {signOut}
    </main>
  );
}
