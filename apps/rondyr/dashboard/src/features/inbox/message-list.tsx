import { cn } from "cn";
import { Download, RefreshCw, Search, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SidebarTrigger } from "~/components/ui/sidebar";
import { useFormats } from "~/lib/i18n";
import type { Inbox, SubmissionEntry } from "~/lib/inbox-client";

import type { Folder, FolderForm } from "./folder-counts.ts";
import { emojiOf, FormEmoji } from "./form-emoji.tsx";
import { excerptOf, listDay, senderOf, subjectOf } from "./message-preview.ts";

type Form = Inbox["forms"][number];

interface MessageRowProps {
  readonly submission: SubmissionEntry;
  /** The form of the message, when its emoji tells it apart from the other forms. */
  readonly form: Form | undefined;
  readonly active: boolean;
  /** The status is shown where a folder mixes several of them. */
  readonly showStatus: boolean;
  readonly now: number;
  readonly onOpen: () => void;
}

function MessageRow({ submission, form, active, showStatus, now, onOpen }: MessageRowProps) {
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
    </button>
  );
}

interface MessageListProps {
  readonly folder: Folder;
  /** The forms of the organization. With several, each message shows the emoji of its form. */
  readonly forms: readonly Form[];
  /** The forms that the folder has messages of, when there are several to tell apart. */
  readonly formsOfFolder: readonly FolderForm[];
  /** The public ID of the form that the list is narrowed to, if any. */
  readonly form: Form["publicId"] | null;
  /** `null` while the first page loads. */
  readonly entries: readonly SubmissionEntry[] | null;
  /** The number of messages listed, when the counts are known. */
  readonly total: number | null;
  /** The number of messages of the folder in the other forms, when the counts are known. */
  readonly elsewhere: number | null;
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
  /** Narrow the list to the messages of a form, or show those of every form again with null. */
  readonly onForm: (form: Form["publicId"] | null) => void;
  /** The text that the list is narrowed to, if any. */
  readonly search: string | null;
  /** Narrow the list to the messages that contain a text, or show them all again with null. */
  readonly onSearch: (search: string | null) => void;
  /** The addresses of the exports of the list, for an admin. */
  readonly exports: { readonly csv: string; readonly jsonl: string } | null;
}

/** The shortest text that the API searches for. */
const minSearchLength = 3;

interface SearchBarProps {
  readonly search: string | null;
  readonly onSearch: (search: string | null) => void;
}

function SearchBar({ search, onSearch }: SearchBarProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(search ?? "");
  const [tooShort, setTooShort] = useState(false);
  return (
    <search className="hairline-b px-3 py-2">
      <form
        className="grid gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = text.trim();
          if (trimmed === "") {
            setTooShort(false);
            onSearch(null);
            return;
          }
          setTooShort(trimmed.length < minSearchLength);
          if (trimmed.length >= minSearchLength) onSearch(trimmed);
        }}
      >
        <div className="flex items-center gap-1">
          <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <Input
            type="search"
            aria-label={t("inbox.list.search.label")}
            placeholder={t("inbox.list.search.placeholder")}
            value={text}
            maxLength={100}
            onChange={(event) => setText(event.currentTarget.value)}
            aria-invalid={tooShort || undefined}
          />
          {search !== null && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("inbox.list.search.clear")}
              onClick={() => {
                setText("");
                setTooShort(false);
                onSearch(null);
              }}
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          )}
        </div>
        {tooShort && (
          <p role="alert" className="text-xs text-destructive">
            {t("inbox.list.search.tooShort", { count: minSearchLength })}
          </p>
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
  readonly form: Form["publicId"] | null;
  readonly onForm: (form: Form["publicId"] | null) => void;
}

/** The forms of the folder, an emoji, a name and a count each. One of them narrows the list. */
function FormChips({ forms, form, onForm }: FormChipsProps) {
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

export function MessageList({
  folder,
  forms,
  formsOfFolder,
  form,
  entries,
  total,
  elsewhere,
  selected,
  hasMore,
  loadingMore,
  failed,
  now,
  collapsed,
  onOpen,
  onMore,
  onRefresh,
  onForm,
  search,
  onSearch,
  exports,
}: MessageListProps) {
  const { t } = useTranslation();
  const formName = forms.find(({ publicId }) => publicId === form)?.name ?? null;
  // With one form, nothing tells the messages apart, so they show no emoji.
  const formOf = (submission: SubmissionEntry) =>
    forms.length > 1
      ? forms.find(({ publicId }) => publicId === submission.formPublicId)
      : undefined;
  return (
    <section
      aria-label={t("inbox.list.label")}
      className={cn("flex min-h-0 flex-col bg-background lg:hairline-r", collapsed && "max-lg:hidden")}
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
      {formsOfFolder.length > 0 && <FormChips forms={formsOfFolder} form={form} onForm={onForm} />}
      <SearchBar search={search} onSearch={onSearch} />
      {exports !== null && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 hairline-b px-4 py-2 text-xs text-muted-foreground">
          <Download aria-hidden="true" className="size-3.5 shrink-0" />
          <span>{t("inbox.list.export.label")}</span>
          <a
            className="font-medium text-foreground underline underline-offset-4"
            href={exports.csv}
            download
          >
            {t("inbox.list.export.csv")}
          </a>
          <a
            className="font-medium text-foreground underline underline-offset-4"
            href={exports.jsonl}
            download
          >
            {t("inbox.list.export.jsonl")}
          </a>
          <span>{t("inbox.list.export.limit")}</span>
        </p>
      )}
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
        {entries?.length === 0 && search !== null && (
          <div className="grid justify-items-start gap-2 px-4 py-10">
            <h2 className="text-base font-semibold text-balance wrap-anywhere">
              {t("inbox.list.search.empty", { search })}
            </h2>
            <Button className="mt-2" onClick={() => onSearch(null)}>
              {t("inbox.list.search.showAll")}
            </Button>
          </div>
        )}
        {entries?.length === 0 && search === null && formName !== null && (
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
        {entries?.length === 0 && search === null && formName === null && (
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
                  form={formOf(submission)}
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
