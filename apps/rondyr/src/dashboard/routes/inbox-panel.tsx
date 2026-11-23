import { cn } from "cn";
import { Schema } from "effect";
import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { ApiTokenList } from "@rondyr/organizations/api-token";
import { allows } from "@rondyr/organizations/member-role";
import type { OrganizationDomainList } from "@rondyr/organizations/organization-domain";

import { ProductLogo } from "~/components/product-logo";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "~/components/ui/sidebar";
import { listApiTokens } from "~/lib/api-tokens-client";
import { getClassificationSettings } from "~/lib/classification-policy-client";
import {
  countSubmissions,
  exportAddress,
  InboxRequestError,
  listInboxes,
  listSubmissions,
} from "~/lib/inbox-client";
import { listMembers } from "~/lib/members-client";
import type { MemberList } from "~/lib/members-client";
import type { Counts, Inbox, Submission, SubmissionEntry } from "~/lib/inbox-client";
import { listDomains } from "~/lib/organization-domains-client";
import { getDailyUsage } from "~/lib/organization-quotas-client";
import { getRetention } from "~/lib/retention-client";

import { NewOrganization } from "~/features/organization/new-organization";
import {
  countsAfterMove,
  countsAfterRemoval,
  countsOfForm,
  formsOfFolder,
  totalOf,
} from "~/lib/folder-counts";
import type { Folder } from "~/lib/folder-counts";
import { OrganizationSidebar } from "~/features/navigation/organization-sidebar";
import type { Page, SettingsSection } from "~/features/navigation/organization-sidebar";
import { MessageList } from "~/features/messages/message-list";
import { OrganizationsUnavailable } from "~/features/organization/organizations-unavailable";
import type { LoadFailure } from "~/features/organization/organizations-unavailable";
import { FormDestinations } from "~/features/destinations/form-destinations";
import { MessageReader } from "~/features/messages/message-reader";

// The pages of the forms and of the settings are not part of the first paint, so
// their code loads when one of them opens.
const FormPage = lazy(async () => {
  const { FormPage: Loaded } = await import("~/features/forms/form-page");
  return { default: Loaded };
});
const NewFormPage = lazy(async () => {
  const { NewFormPage: Loaded } = await import("~/features/forms/form-page");
  return { default: Loaded };
});
const ApiTokenSettings = lazy(async () => {
  const { ApiTokenSettings: Settings } = await import("~/features/organization/api-token-settings");
  return { default: Settings };
});
const OrganizationDomains = lazy(async () => {
  const { OrganizationDomains: Domains } =
    await import("~/features/organization/organization-domains");
  return { default: Domains };
});
const ClassificationSettings = lazy(async () => {
  const { ClassificationSettings: Settings } =
    await import("~/features/organization/classification-settings");
  return { default: Settings };
});
const MemberSettings = lazy(async () => {
  const { MemberSettings: Settings } = await import("~/features/organization/member-settings");
  return { default: Settings };
});
const RetentionSettings = lazy(async () => {
  const { RetentionSettings: Settings } =
    await import("~/features/organization/retention-settings");
  return { default: Settings };
});
const QuotaSettings = lazy(async () => {
  const { QuotaSettings: Settings } = await import("~/features/organization/quota-settings");
  return { default: Settings };
});

const isRequestError = Schema.is(InboxRequestError);

/** Why a read of the organizations failed, from the error that the request threw. */
function loadFailureOf(error: Error): LoadFailure {
  if (isRequestError(error)) return { status: error.status };
  // `fetch` rejects with a TypeError when the server cannot be reached.
  return error instanceof TypeError ? "unreachable" : "unreadable";
}

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

/** A page of the settings, with what it shows, read when the page opens. */
type SettingsSelection =
  | { readonly section: "apiTokens"; readonly tokens: Promise<ApiTokenList | null> }
  | {
      readonly section: "retention";
      readonly retention: Promise<Awaited<ReturnType<typeof getRetention>> | null>;
    }
  | {
      readonly section: "members";
      readonly members: Promise<MemberList | null>;
      readonly readAt: number;
    }
  | { readonly section: "domains"; readonly domains: Promise<OrganizationDomainList | null> }
  | {
      readonly section: "classification";
      readonly policy: Promise<Awaited<ReturnType<typeof getClassificationSettings>> | null>;
    }
  | {
      readonly section: "quotas";
      readonly usage: Promise<Awaited<ReturnType<typeof getDailyUsage>> | null>;
    }
  | { readonly section: "operations" };

/** What the dashboard shows in place of the messages. */
type Selection =
  | Exclude<Page, { readonly at: "settings" }>
  | { readonly at: "settings"; readonly settings: SettingsSelection };

interface SettingsPageProps {
  readonly inboxId: Inbox["id"];
  readonly settings: SettingsSelection;
  /** The page of the processing status, which another feature owns. */
  readonly operations: ReactNode;
  /** Read a page again after a failure. */
  readonly onOpen: (section: SettingsSection) => void;
  readonly onOwnMembershipChanged: () => void;
}

/** One page of the settings of the organization. */
function SettingsPage({
  inboxId,
  settings,
  operations,
  onOpen,
  onOwnMembershipChanged,
}: SettingsPageProps) {
  const retry = () => onOpen(settings.section);
  switch (settings.section) {
    case "operations":
      return operations;
    case "domains":
      return <OrganizationDomains inboxId={inboxId} domains={settings.domains} onRetry={retry} />;
    case "classification":
      return (
        <ClassificationSettings inboxId={inboxId} settings={settings.policy} onRetry={retry} />
      );
    case "apiTokens":
      return <ApiTokenSettings inboxId={inboxId} tokens={settings.tokens} onRetry={retry} />;
    case "members":
      return (
        <MemberSettings
          inboxId={inboxId}
          members={settings.members}
          readAt={settings.readAt}
          onRetry={retry}
          onOwnMembershipChanged={onOwnMembershipChanged}
        />
      );
    case "retention":
      return <RetentionSettings inboxId={inboxId} retention={settings.retention} onRetry={retry} />;
    case "quotas":
      return <QuotaSettings inboxId={inboxId} usage={settings.usage} onRetry={retry} />;
  }
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
  // The public ID of the form that the list is narrowed to.
  const [form, setForm] = useState<string | null>(null);
  // The text that the list is narrowed to.
  const [searchText, setSearch] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  // A reviewer has no page of forms or of settings, even one that was open before a change of role.
  const selection =
    allows(inbox.role, "manage-settings") || selected?.at === "organization" ? selected : null;
  const shownPage: Page | null =
    selection?.at === "settings"
      ? { at: "settings", section: selection.settings.section }
      : selection;
  // A form's page shows the form as the organization has it now.
  const shownForm =
    selection?.at === "form"
      ? inbox.forms.find(({ publicId }) => publicId === selection.publicId)
      : undefined;
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
    void listSubmissions(inbox.id, status, form, searchText, null, request.signal).then(
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
  }, [inbox.id, status, form, searchText, revision]);

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
  const inFolder = counts === null ? null : totalOf(counts, folder);
  const inForm =
    counts === null || form === null ? inFolder : totalOf(countsOfForm(counts, form), folder);
  // The counts know nothing of a search.
  const total = searchText === null ? inForm : null;
  const mayExport = allows(inbox.role, "export-submissions");

  function openFolder(next: Folder, nextForm: string | null) {
    setSelected(null);
    setOpened(null);
    if (next === folder && nextForm === form) return;
    setFolder(next);
    setForm(nextForm);
    setListing(null);
    setFailed(false);
  }

  function openDomains() {
    setSelected({
      at: "settings",
      settings: { section: "domains", domains: listDomains(inbox.id).catch(() => null) },
    });
  }

  function openClassification() {
    setSelected({
      at: "settings",
      settings: {
        section: "classification",
        policy: getClassificationSettings(inbox.id).catch(() => null),
      },
    });
  }

  function openQuotas() {
    setSelected({
      at: "settings",
      settings: { section: "quotas", usage: getDailyUsage(inbox.id).catch(() => null) },
    });
  }

  function openApiTokens() {
    setSelected({
      at: "settings",
      settings: { section: "apiTokens", tokens: listApiTokens(inbox.id).catch(() => null) },
    });
  }

  function openRetention() {
    setSelected({
      at: "settings",
      settings: { section: "retention", retention: getRetention(inbox.id).catch(() => null) },
    });
  }

  function search(next: string | null) {
    setOpened(null);
    if (next === searchText) return;
    setSearch(next);
    setListing(null);
    setFailed(false);
  }

  function openMembers() {
    setSelected({
      at: "settings",
      settings: {
        section: "members",
        members: listMembers(inbox.id).catch(() => null),
        readAt: Date.now(),
      },
    });
  }

  function openSettings(next: SettingsSection) {
    if (next === "domains") openDomains();
    else if (next === "classification") openClassification();
    else if (next === "quotas") openQuotas();
    else if (next === "apiTokens") openApiTokens();
    else if (next === "members") openMembers();
    else if (next === "retention") openRetention();
    else setSelected({ at: "settings", settings: { section: next } });
  }

  function openPage(next: Page) {
    setOpened(null);
    if (next.at !== "settings") setSelected(next);
    // A page of the settings that is already open keeps what it has read.
    else if (shownPage?.at !== "settings" || shownPage.section !== next.section) {
      openSettings(next.section);
    }
  }

  async function loadMore() {
    if (listing === null || listing.cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await listSubmissions(
        inbox.id,
        status,
        form,
        searchText,
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

  /** A message deleted for good leaves the list and the counts. */
  function deleted(gone: SubmissionEntry) {
    setCounts((known) =>
      known === null ? null : countsAfterRemoval(known, gone.formPublicId, gone.status),
    );
    if (listing === null) return;
    const at = listing.entries.findIndex((entry) => entry.submissionId === gone.submissionId);
    const entries = listing.entries.filter((entry) => entry.submissionId !== gone.submissionId);
    setListing({ ...listing, entries });
    setOpened(entries[at] ?? entries[at - 1] ?? null);
  }

  function reviewed(updated: Submission) {
    if (listing !== null) {
      const at = listing.entries.findIndex((entry) => entry.submissionId === updated.submissionId);
      const before = listing.entries[at];
      if (before !== undefined) {
        // The API counts every message of the organization, so the counts follow the decision here.
        setCounts((known) =>
          known === null
            ? null
            : countsAfterMove(known, before.formPublicId, before.status, updated.status),
        );
      }
      if (folder === "all") {
        // The row keeps its preview and takes the new status.
        const decided = (entry: SubmissionEntry) =>
          entry === before
            ? { ...entry, status: updated.status, reason: updated.reason, label: updated.label }
            : entry;
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
      <OrganizationSidebar
        inboxes={inboxes}
        inbox={inbox}
        counts={counts}
        folder={folder}
        page={shownPage}
        account={account}
        onInbox={onInbox}
        onFolder={(next) => openFolder(next, null)}
        onBack={() => openFolder(folder, form)}
        onPage={openPage}
      />
      <SidebarInset className="lg:grid lg:h-dvh lg:inbox-panes">
        {selection === null || (selection.at === "form" && shownForm === undefined) ? (
          <>
            <MessageList
              folder={folder}
              forms={inbox.forms}
              formsOfFolder={
                counts === null ? [] : formsOfFolder(inbox.forms, counts, folder, form)
              }
              form={form}
              entries={listing?.entries ?? null}
              total={total}
              elsewhere={inFolder === null || total === null ? null : inFolder - total}
              selected={current?.submissionId ?? null}
              hasMore={listing !== null && listing.cursor !== null}
              loadingMore={loadingMore}
              failed={failed}
              now={listing?.readAt ?? 0}
              collapsed={current !== null}
              onOpen={setOpened}
              onMore={() => void loadMore()}
              onRefresh={() => setRevision((value) => value + 1)}
              onForm={(next) => openFolder(folder, next)}
              search={searchText}
              onSearch={search}
              exports={
                mayExport
                  ? {
                      csv: exportAddress(inbox.id, "csv", status, form, searchText),
                      jsonl: exportAddress(inbox.id, "jsonl", status, form, searchText),
                    }
                  : null
              }
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
                <MessageReader
                  key={current.submissionId}
                  inboxId={inbox.id}
                  entry={current}
                  fromForm={
                    inbox.forms.length > 1
                      ? inbox.forms.find(({ publicId }) => publicId === current.formPublicId)
                      : undefined
                  }
                  revision={revision}
                  position={index < 0 ? null : index + 1}
                  total={total ?? listing?.entries.length ?? 0}
                  onPrevious={above === undefined ? null : () => setOpened(above)}
                  onNext={below === undefined ? null : () => setOpened(below)}
                  onReviewed={reviewed}
                  onClose={() => setOpened(null)}
                  mayDelete={allows(inbox.role, "delete-submissions")}
                  mayRetry={allows(inbox.role, "retry-deliveries")}
                  onDeleted={() => deleted(current)}
                />
              )}
            </section>
          </>
        ) : (
          <Suspense fallback={<PageFallback />}>
            {selection.at === "form" && shownForm !== undefined && (
              <FormPage
                key={shownForm.publicId}
                inboxId={inbox.id}
                form={shownForm}
                messages={
                  counts === null ? null : totalOf(countsOfForm(counts, shownForm.publicId), "all")
                }
                onChanged={onFormsChanged}
                onMessages={() => openFolder("all", shownForm.publicId)}
                destinations={
                  <FormDestinations
                    key={`destinations-${shownForm.publicId}`}
                    inboxId={inbox.id}
                    form={shownForm}
                  />
                }
              />
            )}
            {selection.at === "newForm" && (
              <NewFormPage
                inboxId={inbox.id}
                onCreated={async (publicId) => {
                  await onFormsChanged();
                  setSelected({ at: "form", publicId });
                }}
              />
            )}
            {selection.at === "organization" && (
              <main className="min-w-0 lg:col-span-2 lg:overflow-y-auto">
                <header className="flex h-14 items-center px-1">
                  <SidebarTrigger />
                </header>
                <div className="mx-auto max-w-xl px-5 pb-8">
                  <NewOrganization onCreated={onOrganizationCreated} />
                </div>
              </main>
            )}
            {selection.at === "settings" && (
              <SettingsPage
                inboxId={inbox.id}
                settings={selection.settings}
                operations={operations}
                onOpen={openSettings}
                onOwnMembershipChanged={() => void onFormsChanged()}
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
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [revision, setRevision] = useState(0);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the signed-in user's organizations from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listInboxes(request.signal).then(setInboxes, (error: Error) => {
      if (!request.signal.aborted) setFailure(loadFailureOf(error));
    });
    return () => request.abort();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Creating a new inbox and a new try initiate a new API request.
  }, [revision]);

  async function reload() {
    await listInboxes().then(setInboxes, (error: Error) => setFailure(loadFailureOf(error)));
  }

  /** Read the organizations again: after one was created, or after a failure. */
  function readAgain() {
    setFailure(null);
    setRevision((value) => value + 1);
  }

  if (failure !== null) {
    return <OrganizationsUnavailable failure={failure} onRetry={readAgain} signOut={signOut} />;
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
        onOrganizationCreated={readAgain}
      />
    );
  }

  return (
    <main className="mx-auto grid max-w-xl gap-5 px-5 py-12">
      <h1 className="flex justify-center">
        <ProductLogo size="lg" />
      </h1>
      {inboxes === null ? (
        <output className="text-center text-sm text-muted-foreground">
          {t("inbox.organizations.loading")}
        </output>
      ) : (
        <>
          <NewOrganization onCreated={readAgain} />
          {signOut}
        </>
      )}
    </main>
  );
}
