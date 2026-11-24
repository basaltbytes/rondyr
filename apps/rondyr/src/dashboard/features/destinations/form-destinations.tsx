import { useMutation, useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ChevronDown, Mail, Plug, Webhook as WebhookIcon } from "lucide-react";
import { useId, useState, useTransition } from "react";
import type { FormEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { connectorOf, connectors } from "@rondyr/deliveries/connectors/catalog";

import { CardListSkeleton } from "~/components/page-pending";
import { ReadFailure } from "~/components/read-failure";
import { SelectField, TextAreaField, TextField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import {
  addDestinationMutation,
  changeDestinationMutation,
  destinationsQuery,
  isConnectorType,
  type DestinationTarget,
  type IssuedWebhookSecret,
  type NewDestination as NewDestinationDraft,
} from "~/lib/api/destinations";
import type { ManagedForm } from "~/lib/api/forms";
import { useLanguage } from "~/lib/i18n";

import {
  ConnectorPanel,
  DraftProblem,
  draftIn,
  NameField,
  SettingFields,
} from "./connector-destination.tsx";
import { addressesIn, EmailPanel, LanguageField, languageIn } from "./email-destination.tsx";
import { attempt, DestinationFailureNote } from "./destination-problems.tsx";
import type { DestinationFailure } from "./destination-problems.tsx";
import { WebhookPanel } from "./webhook-destination.tsx";

/** What names a destination in its row: the URL, the recipients or the name. */
function nameOf(target: DestinationTarget) {
  if (target.type === "webhook") return target.url;
  if (target.type === "email") return target.recipients.join(", ");
  return target.name;
}

interface DestinationRowProps {
  readonly organizationId: string;
  readonly form: ManagedForm;
  readonly target: DestinationTarget;
  readonly open: boolean;
  /** The secret that the API just issued for this destination, if it is a webhook. */
  readonly issued: IssuedWebhookSecret | null;
  readonly onToggle: () => void;
  readonly onIssued: (issued: IssuedWebhookSecret | null) => void;
}

/**
 * A destination on one line: what it is, where it sends, and whether it is on.
 * The line opens on its settings and its test.
 */
function DestinationRow({
  organizationId,
  form,
  target,
  open,
  issued,
  onToggle,
  onIssued,
}: DestinationRowProps) {
  const { t } = useTranslation();
  const panel = useId();
  const { mutateAsync: onChange } = useMutation(
    changeDestinationMutation(organizationId, form.publicId, target.id),
  );
  const [failure, setFailure] = useState<DestinationFailure | null>(null);
  const [switching, startSwitching] = useTransition();
  const name = nameOf(target);
  const Icon = target.type === "webhook" ? WebhookIcon : target.type === "email" ? Mail : Plug;
  const kind =
    target.type === "webhook" || target.type === "email"
      ? t(`inbox.destinations.kinds.${target.type}`)
      : connectorOf(target.type).label;

  function setActive(active: boolean) {
    startSwitching(async () => {
      const failed = await attempt(async () => {
        await onChange({ change: "active", active });
      });
      setFailure(failed);
    });
  }

  let settings: ReactNode;
  if (target.type === "webhook") {
    settings = (
      <WebhookPanel
        organizationId={organizationId}
        target={target}
        issued={issued}
        onChange={onChange}
        onIssued={onIssued}
      />
    );
  } else if (target.type === "email") {
    settings = <EmailPanel organizationId={organizationId} target={target} onChange={onChange} />;
  } else {
    settings = (
      <ConnectorPanel organizationId={organizationId} target={target} onChange={onChange} />
    );
  }

  return (
    <li className="min-w-0 rounded-md bg-muted">
      <div className="flex min-h-11 items-center gap-1 pr-3 pl-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          aria-label={t("inbox.destinations.settingsOf", { name })}
          className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md pr-2 pl-2.5 text-start"
          onClick={onToggle}
        >
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "min-w-0 flex-1 text-sm",
              target.type === "webhook" && "font-mono",
              open ? "wrap-anywhere" : "truncate",
              !target.active && "text-muted-foreground",
            )}
          >
            {name}
          </span>
          {target.type === "webhook" || target.type === "email" ? (
            <span className="sr-only">{kind}</span>
          ) : (
            <Badge>{kind}</Badge>
          )}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </button>
        <Switch
          checked={target.active}
          disabled={switching}
          aria-label={t("inbox.destinations.active", { name })}
          onCheckedChange={setActive}
        />
      </div>
      <DestinationFailureNote failure={failure} fallback={t("inbox.destinations.notSaved")} />
      {open && (
        <div id={panel} className="grid grid-cols-1 gap-3 px-4 pt-1 pb-4">
          {settings}
        </div>
      )}
    </li>
  );
}

interface NewDestinationProps {
  readonly organizationId: string;
  readonly form: ManagedForm;
  /** The destination just added, which opens on its settings. */
  readonly onAdded: (target: DestinationTarget) => void;
  readonly onIssued: (issued: IssuedWebhookSecret) => void;
}

/** Adds a destination. Its type comes first, and decides which fields follow. */
function NewDestination({ organizationId, form, onAdded, onIssued }: NewDestinationProps) {
  const { t } = useTranslation();
  const dashboardLanguage = useLanguage();
  const { mutateAsync: addDestination } = useMutation(
    addDestinationMutation(organizationId, form.publicId),
  );
  const [kind, setKind] = useState<DestinationTarget["type"]>("webhook");
  // The form keeps what was typed when the API refuses it, and empties once saved.
  const [added, setAdded] = useState(0);
  const [failure, setFailure] = useState<DestinationFailure | null>(null);
  const [saving, startSaving] = useTransition();

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startSaving(async () => {
      const failed = await attempt(async () => {
        const draft: NewDestinationDraft =
          kind === "webhook"
            ? { type: "webhook", url: data.get("url")?.toString() ?? "" }
            : kind === "email"
              ? { type: "email", recipients: addressesIn(data), language: languageIn(data) }
              : { type: "connector", draft: draftIn(kind, data) };
        const saved = await addDestination(draft);
        onAdded(saved.target);
        if (saved.issued !== null) onIssued(saved.issued);
        setAdded((count) => count + 1);
      });
      setFailure(failed);
    });
  }

  return (
    <form key={added} onSubmit={add} className="grid gap-3 rounded-md bg-muted p-4">
      <SelectField
        label={t("inbox.destinations.new")}
        hint={
          kind === "webhook"
            ? t("inbox.webhooks.description")
            : kind === "email"
              ? t("inbox.emails.description")
              : t(`inbox.connectors.types.${kind}.about`)
        }
        value={kind}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next === "webhook" || next === "email" || isConnectorType(next)) setKind(next);
          setFailure(null);
        }}
      >
        <option value="webhook">{t("inbox.destinations.kinds.webhook")}</option>
        <option value="email">{t("inbox.destinations.kinds.email")}</option>
        {connectors.map((connector) => (
          <option key={connector.type} value={connector.type}>
            {connector.label}
          </option>
        ))}
      </SelectField>
      {kind === "webhook" && (
        <TextField
          label={t("inbox.webhooks.url")}
          type="url"
          name="url"
          required
          maxLength={2048}
          placeholder={t("inbox.webhooks.placeholder")}
          autoComplete="off"
          spellCheck={false}
        />
      )}
      {kind === "email" && (
        <>
          <TextAreaField
            label={t("inbox.emails.recipients")}
            hint={t("inbox.emails.confirmationNote")}
            name="recipients"
            required
            rows={3}
            placeholder={t("inbox.emails.placeholder")}
            autoComplete="off"
            spellCheck={false}
          />
          {/* A new destination starts in the language of the dashboard. */}
          <LanguageField key={dashboardLanguage} initial={dashboardLanguage} />
        </>
      )}
      {kind !== "webhook" && kind !== "email" && (
        <>
          <NameField initial={undefined} />
          <SettingFields key={kind} kind={kind} saved={null} />
        </>
      )}
      {kind === "webhook" && (
        <DestinationFailureNote failure={failure} fallback={t("inbox.webhooks.notAdded")} />
      )}
      {kind === "email" && (
        <DestinationFailureNote failure={failure} fallback={t("inbox.emails.notAdded")} />
      )}
      {kind !== "webhook" && kind !== "email" && (
        <DraftProblem kind={kind} failure={failure} fallback={t("inbox.connectors.notAdded")} />
      )}
      <Button type="submit" className="justify-self-start" disabled={saving}>
        {kind === "webhook" && t("inbox.webhooks.add")}
        {kind === "email" && t("inbox.emails.add")}
        {kind !== "webhook" && kind !== "email" && t("inbox.connectors.add")}
      </Button>
    </form>
  );
}

interface FormDestinationsProps {
  readonly organizationId: string;
  readonly form: ManagedForm;
}

/**
 * Where the accepted messages of a form go: webhooks, emails and the services
 * of connectors, in one list. A destination just added opens on its settings.
 */
export function FormDestinations({ organizationId, form }: FormDestinationsProps) {
  const { t } = useTranslation();
  const title = useId();
  const query = useQuery(destinationsQuery(organizationId, form.publicId));
  const targets = query.isError ? null : (query.data ?? null);
  const [opened, setOpened] = useState<readonly DestinationTarget["id"][]>([]);
  const [issued, setIssued] = useState<IssuedWebhookSecret | null>(null);

  function toggle(id: DestinationTarget["id"]) {
    setOpened((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]));
  }

  return (
    <section
      aria-label={t("inbox.destinations.label", { name: form.name })}
      className="grid min-w-0 grid-cols-1 content-start gap-3"
    >
      <h2 id={title} className="flex items-baseline gap-2 font-semibold">
        {t("inbox.sections.destinations")}
        {targets !== null && (
          <span className="text-sm font-normal text-muted-foreground tabular-nums">
            {targets.length}
          </span>
        )}
      </h2>
      {query.isError && (
        <ReadFailure
          cause={query.error}
          title={t("inbox.destinations.loadFailed")}
          retry={t("common.retry")}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.isPending && <CardListSkeleton label={t("inbox.destinations.loading")} />}
      {targets?.length === 0 && (
        <p className="text-xs text-pretty text-muted-foreground">{t("inbox.destinations.empty")}</p>
      )}
      {targets !== null && targets.length > 0 && (
        <ul aria-labelledby={title} className="grid grid-cols-1 gap-1.5">
          {targets.map((target) => (
            <DestinationRow
              key={target.id}
              organizationId={organizationId}
              form={form}
              target={target}
              open={opened.includes(target.id)}
              issued={issued?.target.id === target.id ? issued : null}
              onToggle={() => toggle(target.id)}
              onIssued={setIssued}
            />
          ))}
        </ul>
      )}
      <NewDestination
        organizationId={organizationId}
        form={form}
        onAdded={(target) => setOpened((ids) => [...ids, target.id])}
        onIssued={setIssued}
      />
    </section>
  );
}
