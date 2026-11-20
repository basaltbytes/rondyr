import { cn } from "cn";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { SidebarInset, SidebarProvider } from "~/components/ui/sidebar";
import { countSubmissions, listInboxes, listSubmissions } from "~/lib/inbox-client";
import type { Counts, Inbox, Submission } from "~/lib/inbox-client";

import { InboxSettings } from "./inbox-settings.tsx";
import { InboxSetup } from "./inbox-setup.tsx";
import { InboxSidebar } from "./inbox-sidebar.tsx";
import type { Folder, Section } from "./inbox-sidebar.tsx";
import { MessageList } from "./message-list.tsx";
import { SubmissionReader } from "./submission-reader.tsx";

interface Listing {
  readonly entries: readonly Submission[];
  readonly cursor: string | null;
  /** When the first page was read. */
  readonly readAt: number;
}

function totalOf(counts: Counts | null, folder: Folder) {
  if (counts === null) return null;
  if (folder !== "all") return counts[folder];
  return (
    counts.received + counts.classifying + counts.accepted + counts.quarantined + counts.archived
  );
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
  const [folder, setFolder] = useState<Folder>("quarantined");
  const [section, setSection] = useState<Section | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [opened, setOpened] = useState<Submission | null>(null);
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A refresh or a decision initiates a new API request.
  }, [inbox.id, status, revision]);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Synchronizes the folder counts with the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    // The folders work without their counts, so a failure leaves the last known ones.
    void countSubmissions(inbox.id, request.signal).then(setCounts, () => undefined);
    return () => request.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A refresh or a decision initiates a new API request.
  }, [inbox.id, revision]);

  // The row of the list has the latest status of the open message.
  const current =
    opened === null
      ? null
      : (listing?.entries.find((entry) => entry.submissionId === opened.submissionId) ?? opened);

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
      const index = listing.entries.findIndex(
        (entry) => entry.submissionId === updated.submissionId,
      );
      if (folder === "all") {
        setListing({
          ...listing,
          entries: listing.entries.map((entry, position) => (position === index ? updated : entry)),
        });
        setOpened(updated);
      } else {
        // Like a mail client: the decided message leaves the folder and the next one opens.
        const entries = listing.entries.filter((_, position) => position !== index);
        setListing({ ...listing, entries });
        setOpened(entries[index] ?? entries[index - 1] ?? null);
      }
    }
    setRevision((value) => value + 1);
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
              total={totalOf(counts, folder)}
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
              aria-label="Message ouvert"
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
                  submission={current}
                  revision={revision}
                  onReviewed={reviewed}
                  onClose={() => setOpened(null)}
                />
              )}
            </section>
          </>
        ) : section === "operations" ? (
          operations
        ) : (
          <InboxSettings
            section={section}
            inbox={inbox}
            onFormsChanged={onFormsChanged}
            onOrganizationCreated={onOrganizationCreated}
          />
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
  return (
    <>
      {/* The rule under the list's header continues across the empty reader. */}
      <div className="h-14 shrink-0 hairline-b" />
      {waiting !== null && (
        <div className="grid gap-2 px-5 py-6">
          <h2 className="text-base font-semibold text-balance">
            {waiting === 0 ? "Rien à vérifier" : "Aucun message ouvert"}
          </h2>
          <p className="max-w-prose text-pretty text-muted-foreground">
            {waiting === 0 && "Le filtre n’a mis aucun message de côté."}
            {waiting === 1 && "1 message attend votre décision. Ouvrez-le dans la liste."}
            {waiting > 1 &&
              `${waiting} messages attendent votre décision. Ouvrez-en un dans la liste.`}
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
      <h1 className="text-lg font-semibold">Rondyr</h1>
      {failed && (
        <p role="alert" className="text-sm text-destructive">
          Impossible de charger les organisations.
        </p>
      )}
      {inboxes === null && !failed && (
        <output className="text-sm text-muted-foreground">Chargement des organisations…</output>
      )}
      {inboxes !== null && <InboxSetup onCreated={created} />}
      {signOut}
    </main>
  );
}
