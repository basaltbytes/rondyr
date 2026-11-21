import { Badge, Banner, Button, InputArea, Loader, Select } from "@cloudflare/kumo";
import { z } from "astro/zod";
import type { PluginAdminExports } from "emdash";
import { apiFetch } from "emdash/plugin-utils";
import * as React from "react";

import { formsPluginId, pluginId } from "./constants.ts";
import {
  Counts,
  InboxPage,
  Organization,
  SubmissionDetail,
  type InboxEntry,
  type SubmissionStatus,
} from "./core/rondyr-client.ts";
import { fill, languageOf, strings, type Strings } from "./strings.ts";

const pluginApi = `/_emdash/api/plugins/${pluginId}`;
const formsApi = `/_emdash/api/plugins/${formsPluginId}`;
const messagesPage = `/_emdash/admin/plugins/${pluginId}`;
const maxRecipients = 20;

type Failure = keyof Strings["errors"];
const Failure = z.enum([
  "unreachable",
  "unauthorized",
  "not-found",
  "conflict",
  "unexpected",
  "token-missing",
  "failed",
]) satisfies z.ZodType<Failure>;

/** A plugin route that did not answer with its data. */
class AdminError extends Error {
  readonly failure: Failure;
  /** The HTTP status of the plugin route, or null when it was not reached. */
  readonly status: number | null;

  constructor(failure: Failure, status: number | null) {
    super(failure);
    this.failure = failure;
    this.status = status;
  }
}

const ErrorEnvelope = z.object({ error: z.object({ code: Failure.catch("failed") }) });

/** POST a JSON body to a plugin route, with the CSRF header, and decode `{ data }`. */
async function call<T>(api: string, route: string, body: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(`${api}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  } catch {
    throw new AdminError("failed", null);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const envelope = ErrorEnvelope.safeParse(payload);
    throw new AdminError(envelope.success ? envelope.data.error.code : "failed", response.status);
  }
  const parsed = z.object({ data: schema }).safeParse(payload);
  if (!parsed.success) throw new AdminError("unexpected", response.status);
  return parsed.data.data;
}

function useStrings(): Strings {
  return strings[languageOf(document.documentElement.lang)];
}

function formatDate(milliseconds: number): string {
  return new Date(milliseconds).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const Status = z.object({
  token: z.boolean(),
  webhookSecret: z.boolean(),
  queue: z.object({ pending: z.number(), failed: z.number(), unlinked: z.number() }),
});
type Status = z.infer<typeof Status>;

const Overview = z.object({ organization: Organization, counts: Counts });
type Overview = z.infer<typeof Overview>;

const Retried = z.object({ retried: z.number() });

type Folder = Extract<SubmissionStatus, "accepted" | "quarantined" | "archived">;
const folders: readonly Folder[] = ["accepted", "quarantined", "archived"];

function ErrorBanner({ failure }: { readonly failure: Failure }) {
  const text = useStrings();
  return <Banner variant="error" description={text.errors[failure]} />;
}

/** Missing secrets, and what waits in the queue, with Retry for the failed entries. */
function StatusBanners({ onRetried }: { readonly onRetried: () => void }) {
  const text = useStrings();
  const [status, setStatus] = React.useState<Status | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const next = await call(pluginApi, "status", JSON.stringify({ version }), Status);
        if (current) setStatus(next);
      } catch {
        if (current) setStatus(null);
      }
    })();
    return () => {
      current = false;
    };
  }, [version]);

  if (status === null) return null;
  const { pending, failed, unlinked } = status.queue;
  const retry = async () => {
    setRetrying(true);
    try {
      await call(pluginApi, "queue/retry", "{}", Retried);
      onRetried();
    } catch {
      // The banner shows the queue again below; a failed retry leaves it as it was.
    } finally {
      setRetrying(false);
      setVersion((value) => value + 1);
    }
  };
  return (
    <div className="space-y-3">
      {!status.token && <Banner variant="alert" description={text.errors["token-missing"]} />}
      {!status.webhookSecret && (
        <Banner variant="alert" description={text.setup.webhookSecretMissing} />
      )}
      {pending + failed + unlinked > 0 && (
        <Banner
          variant={failed > 0 ? "error" : "default"}
          description={fill(text.queue.summary, { pending, failed, unlinked })}
          action={
            failed > 0 ? (
              <Button size="sm" loading={retrying} onClick={() => void retry()}>
                {retrying ? text.queue.retrying : text.queue.retry}
              </Button>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

function reasonText(text: Strings, reason: string | null): string {
  const known: Readonly<Record<string, string>> = text.reasons;
  return (reason === null ? undefined : known[reason]) ?? text.reasons.unknown;
}

function MessageRow({
  entry,
  onOpen,
}: {
  readonly entry: InboxEntry;
  readonly onOpen: (id: string) => void;
}) {
  const text = useStrings();
  const preview = Object.values(entry.preview).slice(0, 2).join(" · ");
  return (
    <li>
      <button
        type="button"
        className="w-full rounded-lg border border-kumo-line px-4 py-3 text-start hover:bg-kumo-tint"
        onClick={() => onOpen(entry.submissionId)}
      >
        <div className="flex items-center justify-between gap-3 text-xs text-kumo-subtle">
          <span>{entry.formName}</span>
          <span>{formatDate(entry.receivedAt)}</span>
        </div>
        <p className="mt-1 truncate text-sm">{preview}</p>
        {entry.status === "quarantined" && (
          <Badge variant="warning" className="mt-2">
            {reasonText(text, entry.reason)}
          </Badge>
        )}
      </button>
    </li>
  );
}

type Loaded<T> =
  | { readonly key: string; readonly value: T }
  | { readonly key: string; readonly failure: Failure };

function failureOf(error: Error): Failure {
  return error instanceof AdminError ? error.failure : "failed";
}

/** A message with all its fields; Accept and Archive while it waits for review. */
function MessageDetail({
  id,
  onBack,
  onDecided,
}: {
  readonly id: string;
  readonly onBack: () => void;
  readonly onDecided: () => void;
}) {
  const text = useStrings();
  const [detail, setDetail] = React.useState<SubmissionDetail | null>(null);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [working, setWorking] = React.useState(false);

  React.useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const next = await call(
          pluginApi,
          "messages/get",
          JSON.stringify({ id }),
          SubmissionDetail,
        );
        if (current) setDetail(next);
      } catch (error) {
        if (current) setFailure(error instanceof Error ? failureOf(error) : "failed");
      }
    })();
    return () => {
      current = false;
    };
  }, [id]);

  const decide = async (decision: "approve" | "dismiss") => {
    setWorking(true);
    setNotice(null);
    try {
      const body = JSON.stringify({ id, decision });
      setDetail(await call(pluginApi, "messages/decide", body, SubmissionDetail));
      onDecided();
    } catch (error) {
      const reason = error instanceof Error ? failureOf(error) : "failed";
      if (reason !== "conflict") {
        setFailure(reason);
      } else {
        setNotice(text.messages.alreadyDecided);
        onDecided();
        setDetail(await call(pluginApi, "messages/get", JSON.stringify({ id }), SubmissionDetail));
      }
    } finally {
      setWorking(false);
    }
  };

  const fields = detail === null ? [] : Object.entries(detail.fields);
  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack}>
        {text.messages.back}
      </Button>
      {failure !== null && <ErrorBanner failure={failure} />}
      {notice !== null && <Banner description={notice} />}
      {detail === null && failure === null && <Loader />}
      {detail !== null && (
        <article className="space-y-4">
          <header className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold">{detail.formName}</h2>
            <Badge variant={detail.status === "quarantined" ? "warning" : "neutral"}>
              {text.status[detail.status]}
            </Badge>
            <span className="text-sm text-kumo-subtle">
              {fill(text.messages.received, { date: formatDate(detail.receivedAt) })}
            </span>
          </header>
          {detail.status === "quarantined" && (
            <Banner
              variant="alert"
              title={text.messages.reasonLabel}
              description={reasonText(text, detail.reason)}
            />
          )}
          {fields.length === 0 ? (
            <p className="text-sm">{text.messages.noFields}</p>
          ) : (
            <dl className="space-y-3">
              {fields.map(([name, value]) => (
                <div key={name}>
                  <dt className="text-xs font-medium text-kumo-subtle">{name}</dt>
                  <dd className="whitespace-pre-wrap break-words text-sm">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {detail.status === "quarantined" && (
            <div className="flex gap-2">
              <Button variant="primary" loading={working} onClick={() => void decide("approve")}>
                {working ? text.messages.working : text.messages.accept}
              </Button>
              <Button loading={working} onClick={() => void decide("dismiss")}>
                {text.messages.archive}
              </Button>
            </div>
          )}
        </article>
      )}
    </div>
  );
}

interface FirstPage {
  readonly overview: Overview;
  readonly page: InboxPage;
}

/** The three folders of the Rondyr inbox, read live from Rondyr: nothing is cached. */
function MessagesPage() {
  const text = useStrings();
  const [folder, setFolder] = React.useState<Folder>("quarantined");
  const [form, setForm] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState(0);
  const [loaded, setLoaded] = React.useState<Loaded<FirstPage> | null>(null);
  const [more, setMore] = React.useState<readonly InboxEntry[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [open, setOpen] = React.useState<string | null>(null);
  const refresh = React.useCallback(() => setVersion((value) => value + 1), []);
  const key = `${folder}|${form ?? ""}|${version}`;

  React.useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const [overview, page] = await Promise.all([
          call(pluginApi, "messages/overview", "{}", Overview),
          call(pluginApi, "messages/list", JSON.stringify({ status: folder, form }), InboxPage),
        ]);
        if (!current) return;
        setLoaded({ key, value: { overview, page } });
        setMore([]);
        setCursor(page.cursor);
      } catch (error) {
        // Rondyr unreachable or the token refused: show nothing stale.
        if (current)
          setLoaded({ key, failure: error instanceof Error ? failureOf(error) : "failed" });
      }
    })();
    return () => {
      current = false;
    };
  }, [key, folder, form]);

  const loadMore = async () => {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const body = JSON.stringify({ status: folder, form, after: cursor });
      const page = await call(pluginApi, "messages/list", body, InboxPage);
      setMore((previous) => [...previous, ...page.entries]);
      setCursor(page.cursor);
    } catch (error) {
      setLoaded({ key, failure: error instanceof Error ? failureOf(error) : "failed" });
    } finally {
      setLoadingMore(false);
    }
  };

  const current = loaded?.key === key ? loaded : null;
  const first = current !== null && "value" in current ? current.value : null;
  const failure = current !== null && "failure" in current ? current.failure : null;
  const entries = first === null ? [] : [...first.page.entries, ...more];
  const formItems = [
    { label: text.messages.allForms, value: "" },
    ...(first?.overview.organization.forms.map(({ name, publicId }) => ({
      label: name,
      value: publicId,
    })) ?? []),
  ];
  const counts =
    form === null
      ? first?.overview.counts
      : first?.overview.counts.forms.find(({ publicId }) => publicId === form)?.counts;

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold">{text.messages.title}</h1>
      <StatusBanners onRetried={refresh} />
      {open !== null ? (
        <MessageDetail key={open} id={open} onBack={() => setOpen(null)} onDecided={refresh} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex gap-2">
              {folders.map((name) => (
                <Button
                  key={name}
                  variant={folder === name ? "primary" : "secondary"}
                  aria-pressed={folder === name}
                  onClick={() => setFolder(name)}
                >
                  {text.messages.folders[name]} ({counts?.[name] ?? 0})
                </Button>
              ))}
            </div>
            <div className="w-64">
              <Select
                label={text.messages.formFilter}
                hideLabel={false}
                value={form ?? ""}
                onValueChange={(value) =>
                  setForm(value === null || value === "" ? null : String(value))
                }
                items={formItems}
              />
            </div>
          </div>
          {failure !== null && <ErrorBanner failure={failure} />}
          {first !== null && entries.length === 0 && (
            <p className="text-sm text-kumo-subtle">{text.messages.empty}</p>
          )}
          <ul className="space-y-2">
            {entries.map((entry) => (
              <MessageRow key={entry.submissionId} entry={entry} onOpen={setOpen} />
            ))}
          </ul>
          {(current === null || loadingMore) && <Loader />}
          {first !== null && !loadingMore && cursor !== null && (
            <Button onClick={() => void loadMore()}>{text.messages.loadMore}</Button>
          )}
        </>
      )}
    </div>
  );
}

const EmDashForm = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  settings: z.object({
    notifyEmails: z.array(z.string()).default([]),
    autoresponder: z.object({ subject: z.string() }).nullable().optional(),
  }),
});
type EmDashForm = z.infer<typeof EmDashForm>;

const EmDashForms = z.object({ items: z.array(EmDashForm) });

const Link = z.object({ rondyrFormId: z.string().nullable(), recipients: z.array(z.string()) });
type Link = z.infer<typeof Link>;

const Settings = z.object({
  links: z.array(z.object({ slug: z.string(), link: Link })),
  token: z.boolean(),
  webhookSecret: z.boolean(),
  webhookUrl: z.string(),
  organization: Organization.nullable(),
  error: Failure.catch("failed").nullable(),
});
type Settings = z.infer<typeof Settings>;

const Saved = z.object({ requeued: z.number() });

const emailAddress = z.email();

function parseRecipients(value: string): readonly string[] {
  return [...new Set(value.split(/[\s,;]+/u).filter((address) => address !== ""))];
}

function FormLinkEditor({
  form,
  link,
  settings,
}: {
  readonly form: EmDashForm;
  readonly link: Link | null;
  readonly settings: Settings;
}) {
  const text = useStrings();
  const [rondyrFormId, setRondyrFormId] = React.useState(link?.rondyrFormId ?? "");
  const [recipients, setRecipients] = React.useState((link?.recipients ?? []).join("\n"));
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const items = [
    { label: text.settings.notLinked, value: "" },
    ...(settings.organization?.forms.map(({ name, publicId }) => ({
      label: name,
      value: publicId,
    })) ?? []),
  ];
  const sendsOwnEmails =
    rondyrFormId !== "" &&
    (form.settings.notifyEmails.length > 0 ||
      (form.settings.autoresponder !== null && form.settings.autoresponder !== undefined));

  const save = async () => {
    const addresses = parseRecipients(recipients);
    const invalid = addresses.find((address) => !emailAddress.safeParse(address).success);
    setSaved(false);
    if (invalid !== undefined) {
      setError(fill(text.settings.invalidEmail, { email: invalid }));
      return;
    }
    if (addresses.length > maxRecipients) {
      setError(fill(text.settings.tooManyRecipients, { max: maxRecipients }));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const body = JSON.stringify({
        slug: form.slug,
        rondyrFormId: rondyrFormId === "" ? null : rondyrFormId,
        recipients: addresses,
      });
      await call(pluginApi, "settings/save", body, Saved);
      setSaved(true);
    } catch (failure) {
      setError(text.errors[failure instanceof Error ? failureOf(failure) : "failed"]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border border-kumo-line p-4">
      <h2 className="font-semibold">{form.name}</h2>
      {sendsOwnEmails && (
        <Banner
          variant="alert"
          description={fill(text.settings.formsEmails, { name: form.name })}
        />
      )}
      <Select
        label={text.settings.rondyrForm}
        hideLabel={false}
        value={rondyrFormId}
        onValueChange={(value) => setRondyrFormId(value === null ? "" : String(value))}
        items={items}
      />
      <InputArea
        label={text.settings.recipients}
        description={text.settings.recipientsHelp}
        value={recipients}
        onValueChange={setRecipients}
        rows={3}
        error={error ?? undefined}
      />
      <div className="flex items-center gap-3">
        <Button variant="primary" loading={saving} onClick={() => void save()}>
          {text.settings.save}
        </Button>
        {saved && <span className="text-sm text-kumo-subtle">{text.settings.saved}</span>}
      </div>
    </section>
  );
}

interface SettingsData {
  readonly settings: Settings;
  readonly forms: readonly EmDashForm[];
}

/** Per EmDash form: its Rondyr form and its notification recipients. Administrators only. */
function SettingsPage() {
  const text = useStrings();
  const [loaded, setLoaded] = React.useState<Loaded<SettingsData> | null>(null);
  const [forbidden, setForbidden] = React.useState(false);

  React.useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const [settings, forms] = await Promise.all([
          call(pluginApi, "settings/get", "{}", Settings),
          call(formsApi, "forms/list", "{}", EmDashForms),
        ]);
        if (current) setLoaded({ key: "settings", value: { settings, forms: forms.items } });
      } catch (error) {
        if (!current) return;
        // Editors read the messages; only administrators open the settings.
        if (error instanceof AdminError && error.status === 403) setForbidden(true);
        else
          setLoaded({
            key: "settings",
            failure: error instanceof Error ? failureOf(error) : "failed",
          });
      }
    })();
    return () => {
      current = false;
    };
  }, []);

  if (forbidden) {
    return (
      <div className="p-6">
        <Banner description={text.settings.adminOnly} />
      </div>
    );
  }
  if (loaded === null) {
    return (
      <div className="p-6">
        <Loader />
      </div>
    );
  }
  if ("failure" in loaded) {
    return (
      <div className="p-6">
        <ErrorBanner failure={loaded.failure} />
      </div>
    );
  }
  const { settings, forms } = loaded.value;
  const links = new Map(settings.links.map(({ slug, link }) => [slug, link]));
  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold">{text.settings.title}</h1>
      {!settings.token && <Banner variant="alert" description={text.errors["token-missing"]} />}
      {!settings.webhookSecret && (
        <Banner variant="alert" description={text.setup.webhookSecretMissing} />
      )}
      {settings.error !== null && settings.token && (
        <Banner
          variant="error"
          title={text.settings.unavailable}
          description={text.errors[settings.error]}
        />
      )}
      <div>
        <p className="text-sm font-medium">{text.settings.webhookUrl}</p>
        <code className="text-sm">{settings.webhookUrl}</code>
      </div>
      {forms.length === 0 && <p className="text-sm">{text.settings.noForms}</p>}
      {forms.map((form) => (
        <FormLinkEditor
          key={form.id}
          form={form}
          link={links.get(form.slug) ?? null}
          settings={settings}
        />
      ))}
    </div>
  );
}

/** The number of messages to review, from Rondyr. */
function ToReviewWidget() {
  const text = useStrings();
  const [loaded, setLoaded] = React.useState<Loaded<number> | null>(null);

  React.useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const overview = await call(pluginApi, "messages/overview", "{}", Overview);
        if (current) setLoaded({ key: "widget", value: overview.counts.quarantined });
      } catch (error) {
        if (current)
          setLoaded({
            key: "widget",
            failure: error instanceof Error ? failureOf(error) : "failed",
          });
      }
    })();
    return () => {
      current = false;
    };
  }, []);

  if (loaded === null) return <Loader />;
  if ("failure" in loaded) return <p className="text-sm">{text.errors[loaded.failure]}</p>;
  return (
    <div className="space-y-2">
      <p className="text-3xl font-semibold">{loaded.value}</p>
      <p className="text-sm text-kumo-subtle">{text.widget.toReview}</p>
      <a className="text-sm underline" href={messagesPage}>
        {text.widget.open}
      </a>
    </div>
  );
}

export const pages: PluginAdminExports["pages"] = {
  "/": MessagesPage,
  "/settings": SettingsPage,
};

export const widgets: PluginAdminExports["widgets"] = {
  "to-review": ToReviewWidget,
};
