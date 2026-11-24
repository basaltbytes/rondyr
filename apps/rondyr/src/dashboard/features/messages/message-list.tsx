import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { Download, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { minSearchLength } from "@rondyr/contracts/inbox";
import { allows } from "@rondyr/organizations/member-role";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { emojiOf, FormEmoji } from "~/components/form-emoji";
import { ReadFailure } from "~/components/read-failure";
import { Input } from "~/components/ui/input";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { Skeleton } from "~/components/ui/skeleton";
import type { ManagedForm } from "~/lib/api/forms";
import {
  exportAddress,
  messageCountsQuery,
  messageListQuery,
  refreshMessages,
  type InboxEntry,
} from "~/lib/api/messages";
import type { Organization } from "~/lib/api/organizations";
import { countsOfForm, formsOfFolder, totalOf, type FolderForm } from "~/lib/folder-counts";
import { useFormats } from "~/lib/i18n";
import {
  messagesSearch,
  searchTransition,
  type Folder,
  type MessagesSearch,
} from "~/lib/messages-search";

import { excerptOf, listDay, senderOf, subjectOf } from "./message-preview.ts";

interface MessageRowProps {
  readonly organizationId: Organization["id"];
  readonly submission: InboxEntry;
  /** The search params of the list, which the address of the open message keeps. */
  readonly search: MessagesSearch;
  /** The form of the message, when its emoji tells it apart from the other forms. */
  readonly form: ManagedForm | undefined;
  readonly active: boolean;
  /** The status is shown where a folder mixes several of them. */
  readonly showStatus: boolean;
  readonly now: number;
}

/** A message of the list: a link to its address, with the list beside it. */
function MessageRow({
  organizationId,
  submission,
  search,
  form,
  active,
  showStatus,
  now,
}: MessageRowProps) {
  const { t } = useTranslation();
  const format = useFormats();
  const sender = senderOf(submission.preview);
  const subject = subjectOf(submission.preview);
  const day = listDay(submission.receivedAt, now);
  return (
    <Link
      to="/o/$organizationId/messages/$submissionId"
      params={{ organizationId, submissionId: submission.submissionId }}
      search={search}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full gap-3 border-l-3 px-4 py-3 text-start transition-colors duration-150 ease-out",
        active ? "border-l-primary bg-primary/10" : "border-l-transparent hover:bg-muted",
      )}
    >
      {form !== undefined && (
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-lg leading-none"
        >
          {emojiOf(form)}
        </span>
      )}
      <span className="grid min-w-0 flex-1 grid-cols-1 gap-1">
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
      </span>
    </Link>
  );
}

interface MessageListProps {
  readonly organization: Organization;
  /** The folder, the form and the text of the list, from its address. */
  readonly search: MessagesSearch;
  /** The ID of the open message, if any. A narrow screen then hides the list. */
  readonly openId: string | null;
  /** Narrow the list to the messages of a form, or show those of every form again with null. */
  readonly onForm: (form: ManagedForm["publicId"] | null) => void;
  /** Narrow the list to the messages that contain a text, or show them all again with null. */
  readonly onSearch: (search: string | null, replace?: boolean) => void;
}

/** Delay before live typing triggers a search request. */
const searchDebounceMs = 250;

const skeletonRows = [0, 1, 2, 3, 4, 5] as const;

function MessageListSkeleton({
  label,
  showEmoji,
}: {
  readonly label: string;
  readonly showEmoji: boolean;
}) {
  return (
    <div>
      <output className="sr-only">{label}</output>
      <ul aria-hidden="true" className="divide-y divide-border">
        {skeletonRows.map((row) => (
          <li key={row} className="flex gap-3 px-4 py-3">
            {showEmoji && <Skeleton className="mt-0.5 size-8 shrink-0" />}
            <div className="grid min-w-0 flex-1 gap-2">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-10" />
              </div>
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3 w-2/3" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SearchBarProps {
  readonly search: string | null;
  readonly fetching: boolean;
  readonly resultCount: number | null;
  readonly hasMoreResults: boolean;
  readonly fromCache: boolean;
  readonly onSearch: (search: string | null, replace?: boolean) => void;
}

function SearchBar({
  search,
  fetching,
  resultCount,
  hasMoreResults,
  fromCache,
  onSearch,
}: SearchBarProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(search ?? "");
  const [syncedSearch, setSyncedSearch] = useState(search);
  const [submittedTooShort, setSubmittedTooShort] = useState(false);
  const [pendingQuery, setPendingQuery] = useState<{
    readonly value: string | null;
    readonly replace: boolean;
  } | null>(null);

  if (search !== syncedSearch) {
    setSyncedSearch(search);
    setText(search ?? "");
    setSubmittedTooShort(false);
    setPendingQuery(null);
  }

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- schedules and cancels the window.setTimeout debounce timer for live search
  useEffect(() => {
    if (pendingQuery === null) return;
    const timer = window.setTimeout(() => {
      setPendingQuery(null);
      setSyncedSearch(pendingQuery.value);
      onSearch(pendingQuery.value, pendingQuery.replace);
    }, searchDebounceMs);
    return () => window.clearTimeout(timer);
  }, [pendingQuery, onSearch]);

  function applySearch(next: string | null, replace: boolean) {
    setPendingQuery(null);
    setSyncedSearch(next);
    onSearch(next, replace);
  }

  function handleChange(value: string) {
    setText(value);
    setSubmittedTooShort(false);
    const transition = searchTransition(value, search);
    if (transition.action === "unchanged") {
      setPendingQuery(null);
      return;
    }
    if (transition.action === "clear") {
      applySearch(null, true);
      return;
    }
    if (transition.action === "too-short") {
      setPendingQuery(transition.clearActive ? { value: null, replace: true } : null);
      return;
    }
    setPendingQuery({ value: transition.query, replace: search !== null });
  }

  const trimmedLength = text.trim().length;
  const typingTooShort = trimmedLength > 0 && trimmedLength < minSearchLength;
  const busy = pendingQuery !== null || (fetching && search !== null);

  return (
    <search className="hairline-b px-3 py-2">
      <form
        className="grid gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          setPendingQuery(null);
          const trimmed = text.trim();
          if (trimmed === "") {
            setSubmittedTooShort(false);
            if (search !== null) applySearch(null, false);
            return;
          }
          if (trimmed.length < minSearchLength) {
            setSubmittedTooShort(true);
            return;
          }
          setSubmittedTooShort(false);
          if (trimmed !== search) applySearch(trimmed, false);
        }}
      >
        <div className="flex items-center gap-1.5">
          {busy ? (
            <Loader2
              aria-hidden="true"
              className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            />
          ) : (
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          )}
          <Input
            type="search"
            aria-label={t("inbox.list.search.label")}
            placeholder={t("inbox.list.search.placeholder")}
            value={text}
            maxLength={100}
            onChange={(event) => handleChange(event.currentTarget.value)}
            aria-invalid={submittedTooShort || undefined}
          />
          {(text !== "" || search !== null) && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("inbox.list.search.clear")}
              onClick={() => {
                setPendingQuery(null);
                setText("");
                setSubmittedTooShort(false);
                if (search !== null) applySearch(null, false);
              }}
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          )}
        </div>
        {submittedTooShort && (
          <p role="alert" className="text-xs text-destructive">
            {t("inbox.list.search.tooShort", { count: minSearchLength })}
          </p>
        )}
        {!submittedTooShort && typingTooShort && (
          <p className="text-xs text-muted-foreground">
            {t("inbox.list.search.tooShort", { count: minSearchLength })}
          </p>
        )}
        {!submittedTooShort && !typingTooShort && busy && (
          <output className="text-xs text-muted-foreground">
            {t("inbox.list.search.searching")}
          </output>
        )}
        {!submittedTooShort &&
          !typingTooShort &&
          !busy &&
          search !== null &&
          resultCount !== null &&
          resultCount > 0 && (
            <output className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              <span>
                {hasMoreResults
                  ? t("inbox.list.search.resultsMore", { count: resultCount })
                  : t("inbox.list.search.results", { count: resultCount })}
              </span>
              {fromCache && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{t("inbox.list.search.cached")}</span>
                </>
              )}
            </output>
          )}
      </form>
    </search>
  );
}

/** A choice of the row of forms. The chosen one has the surface of a current page. */
function chip(active: boolean) {
  return cn(
    "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out pointer-coarse:h-11",
    active
      ? "border-border bg-primary text-primary-foreground"
      : "border-transparent bg-muted text-muted-foreground hover:text-foreground",
  );
}

interface FormChipsProps {
  readonly forms: readonly FolderForm[];
  readonly form: ManagedForm["publicId"] | null;
  readonly onForm: (form: ManagedForm["publicId"] | null) => void;
  readonly onPrefetchForm: (form: ManagedForm["publicId"] | null) => void;
}

/** The forms of the folder, an emoji, a name and a count each. One of them narrows the list. */
function FormChips({ forms, form, onForm, onPrefetchForm }: FormChipsProps) {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("inbox.list.forms.label")}
      className="flex shrink-0 gap-1.5 overflow-x-auto hairline-b px-3 py-2"
    >
      <button
        type="button"
        aria-pressed={form === null}
        className={chip(form === null)}
        onMouseEnter={() => onPrefetchForm(null)}
        onFocus={() => onPrefetchForm(null)}
        onClick={() => onForm(null)}
      >
        {t("inbox.list.forms.all")}
      </button>
      {forms.map(({ form: part, total }) => (
        <button
          key={part.publicId}
          type="button"
          aria-pressed={part.publicId === form}
          className={chip(part.publicId === form)}
          onMouseEnter={() => onPrefetchForm(part.publicId)}
          onFocus={() => onPrefetchForm(part.publicId)}
          onClick={() => onForm(part.publicId)}
        >
          <FormEmoji form={part} className="text-sm" />
          <span className="max-w-32 truncate">{part.name}</span>
          <span className="tabular-nums opacity-70">{total}</span>
        </button>
      ))}
    </nav>
  );
}

interface ExportMenuProps {
  /** The addresses that download the list as it is filtered on screen. */
  readonly exports: { readonly csv: string; readonly jsonl: string };
}

/** Downloads the list on screen. The menu says what each format holds, and the limit. */
function ExportMenu({ exports }: ExportMenuProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" aria-label={t("inbox.list.export.label")} />}
      >
        <Download aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("inbox.list.export.label")}</DropdownMenuLabel>
          <DropdownMenuLinkItem href={exports.csv} download>
            <span className="grid gap-0.5">
              <span className="font-medium">{t("inbox.list.export.csv")}</span>
              <span className="text-xs text-pretty text-muted-foreground">
                {t("inbox.list.export.csvAbout")}
              </span>
            </span>
          </DropdownMenuLinkItem>
          <DropdownMenuLinkItem href={exports.jsonl} download>
            <span className="grid gap-0.5">
              <span className="font-medium">{t("inbox.list.export.jsonl")}</span>
              <span className="text-xs text-pretty text-muted-foreground">
                {t("inbox.list.export.jsonlAbout")}
              </span>
            </span>
          </DropdownMenuLinkItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-xs text-pretty text-muted-foreground">
          {t("inbox.list.export.limit")}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MessageList({ organization, search, openId, onForm, onSearch }: MessageListProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useInfiniteQuery(messageListQuery(organization.id, search));
  const { data: counts } = useQuery(messageCountsQuery(organization.id));
  const [cachedSearch, setCachedSearch] = useState<string | null>(null);
  const folder: Folder = search.folder;
  const form = search.form ?? null;
  const searchText = search.q ?? null;
  const { forms } = organization;
  // A failed read shows why in place of the list it read before; a failed next page keeps it.
  const failed = list.isError && !list.isFetchNextPageError;
  const entries = failed ? null : (list.data?.pages.flatMap((page) => page.entries) ?? null);
  const inFolder = counts === undefined ? null : totalOf(counts, folder);
  const inForm =
    counts === undefined || form === null ? inFolder : totalOf(countsOfForm(counts, form), folder);
  // The counts know nothing of a search.
  const total = searchText === null ? inForm : null;
  const elsewhere = inFolder === null || total === null ? null : inFolder - total;
  const folderForms = counts === undefined ? [] : formsOfFolder(forms, counts, folder, form);
  const formName = forms.find(({ publicId }) => publicId === form)?.name ?? null;
  const refreshing = list.isFetching && !list.isPending && !list.isFetchingNextPage;
  const fromCache =
    searchText !== null &&
    cachedSearch === searchText &&
    !list.isFetching &&
    !list.isPlaceholderData;
  const exports = allows(organization.role, "export-submissions")
    ? {
        csv: exportAddress(organization.id, "csv", search),
        jsonl: exportAddress(organization.id, "jsonl", search),
      }
    : null;
  // With one form, nothing tells the messages apart, so they show no emoji.
  const formOf = (submission: InboxEntry) =>
    forms.length > 1
      ? forms.find(({ publicId }) => publicId === submission.formPublicId)
      : undefined;

  function handleSearch(next: string | null, replace?: boolean) {
    if (next !== null) {
      const target = messageListQuery(organization.id, messagesSearch(folder, form, next));
      const state = queryClient.getQueryState(target.queryKey);
      const isFreshCacheHit =
        state?.data !== undefined &&
        !state.isInvalidated &&
        Date.now() - state.dataUpdatedAt < 30_000;
      setCachedSearch(isFreshCacheHit ? next : null);
    } else {
      setCachedSearch(null);
    }
    onSearch(next, replace);
  }

  return (
    <section
      aria-label={t("inbox.list.label")}
      className={cn(
        "flex min-h-0 flex-col bg-background lg:hairline-r",
        openId !== null && "max-lg:hidden",
      )}
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
        {exports !== null && <ExportMenu exports={exports} />}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("common.refresh")}
          onClick={() => {
            setCachedSearch(null);
            void refreshMessages(queryClient, organization.id);
          }}
        >
          <RefreshCw
            aria-hidden="true"
            className={cn("size-4", refreshing && "animate-spin motion-reduce:animate-none")}
          />
        </Button>
      </header>
      {folderForms.length > 0 && (
        <FormChips
          forms={folderForms}
          form={form}
          onForm={onForm}
          onPrefetchForm={(next) => {
            if (next === form) return;
            void queryClient
              .infiniteQuery(
                messageListQuery(organization.id, messagesSearch(folder, next, searchText)),
              )
              .catch(() => undefined);
          }}
        />
      )}
      <SearchBar
        search={searchText}
        fetching={list.isFetching && !list.isFetchNextPageError}
        resultCount={entries === null ? null : entries.length}
        hasMoreResults={list.hasNextPage}
        fromCache={fromCache}
        onSearch={handleSearch}
      />
      <div className="min-h-0 flex-1 lg:overflow-y-auto">
        {list.isError && (
          <ReadFailure
            className="px-4 py-3"
            cause={list.error}
            title={t("inbox.list.loadFailed")}
            retry={t("common.retry")}
            retrying={list.isFetching}
            onRetry={() => void (list.isFetchNextPageError ? list.fetchNextPage() : list.refetch())}
          />
        )}
        {list.isPending && (
          <MessageListSkeleton label={t("inbox.list.loading")} showEmoji={forms.length > 1} />
        )}
        {entries?.length === 0 && searchText !== null && (
          <div className="grid justify-items-start gap-2 px-4 py-10">
            <h2 className="text-base font-semibold text-balance wrap-anywhere">
              {t("inbox.list.search.empty", { search: searchText })}
            </h2>
            <Button className="mt-2" onClick={() => handleSearch(null, false)}>
              {t("inbox.list.search.showAll")}
            </Button>
          </div>
        )}
        {entries?.length === 0 && searchText === null && formName !== null && (
          <div className="grid justify-items-start gap-2 px-4 py-10">
            <h2 className="text-base font-semibold text-balance wrap-anywhere">
              {t("inbox.list.form.empty.title", { name: formName })}
            </h2>
            {elsewhere !== null && (
              <p className="max-w-prose text-sm text-pretty text-muted-foreground">
                {t("inbox.list.form.empty.others", { count: elsewhere })}
              </p>
            )}
            <Button className="mt-2" onClick={() => onForm(null)}>
              {t("inbox.list.form.empty.showAll")}
            </Button>
          </div>
        )}
        {entries?.length === 0 && searchText === null && formName === null && (
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
          <ul
            className={cn(
              "transition-opacity duration-150",
              list.isPlaceholderData && "opacity-60",
            )}
          >
            {entries.map((submission) => (
              <li key={submission.submissionId} className="hairline-b">
                <MessageRow
                  organizationId={organization.id}
                  submission={submission}
                  search={search}
                  form={formOf(submission)}
                  active={submission.submissionId === openId}
                  showStatus={folder === "all"}
                  now={list.dataUpdatedAt}
                />
              </li>
            ))}
          </ul>
        )}
        {list.hasNextPage && !failed && (
          <div className="p-4">
            <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              {list.isFetchingNextPage ? t("inbox.list.loadingMore") : t("inbox.list.more")}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
