import { Option, Schema } from "effect";
import { useActionState, useEffect, useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { connectorOf, connectors } from "@rondyr/deliveries/connectors/catalog";

import { FormProblem, SelectField, TextField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import type { Inbox } from "~/lib/inbox-client";
import {
  createConnectorTarget,
  isConnectorDestination,
  isConnectorType,
  listTargets,
  replaceConnectorSettings,
  setTargetActive,
} from "~/lib/targets-client";
import type { ConnectorDestination, ConnectorDraft } from "~/lib/targets-client";

import { attempt, TargetFailureNote } from "./target-problems.tsx";
import type { TargetFailure } from "./target-problems.tsx";
import { TargetTest } from "./target-test.tsx";

type Kind = ConnectorDestination["type"];

const FieldTexts = Schema.Record(
  Schema.String,
  Schema.Struct({ label: Schema.String, hint: Schema.String }),
);
const readFieldTexts = Schema.decodeUnknownOption(FieldTexts);
const noTexts: typeof FieldTexts.Type = {};

/**
 * The label and the help of a setting of a connector, in the language shown.
 * A connector declares its settings in the Worker's code, so their texts are
 * read by name: `lib/connector-texts.test.ts` checks that none is missing.
 */
function useFieldTexts(kind: Kind) {
  const { t } = useTranslation();
  const texts = Option.getOrElse(
    readFieldTexts(t(`inbox.connectors.types.${kind}.fields`, { returnObjects: true })),
    () => noTexts,
  );
  return (name: string) => texts[name] ?? { label: name, hint: "" };
}

const settingName = (name: string) => `setting.${name}`;

/** The name and the settings typed in a form of this file. */
function draftIn(kind: Kind, data: FormData): ConnectorDraft {
  return {
    type: kind,
    name: data.get("name")?.toString() ?? "",
    settings: Object.fromEntries(
      connectorOf(kind).fields.map(({ name }) => [
        name,
        data.get(settingName(name))?.toString() ?? "",
      ]),
    ),
  };
}

interface NameFieldProps {
  /** The name that the field shows first. */
  readonly initial: string | undefined;
}

/** The name of a destination. It stays as typed when the service of a new one changes. */
function NameField({ initial }: NameFieldProps) {
  const { t } = useTranslation();
  return (
    <TextField
      label={t("inbox.connectors.name")}
      hint={t("inbox.connectors.nameHint")}
      name="name"
      required
      maxLength={80}
      defaultValue={initial}
      autoComplete="off"
    />
  );
}

interface SettingFieldsProps {
  readonly kind: Kind;
  /** The destination that the form edits, or null for a new one. */
  readonly saved: ConnectorDestination | null;
}

/** One field per setting of a connector. */
function SettingFields({ kind, saved }: SettingFieldsProps) {
  const { t } = useTranslation();
  const textOf = useFieldTexts(kind);
  return (
    <>
      {connectorOf(kind).fields.map((field) => {
        const { label, hint } = textOf(field.name);
        return (
          <TextField
            key={field.name}
            label={field.optional ? t("inbox.connectors.optional", { label }) : label}
            hint={hint}
            name={settingName(field.name)}
            // A secret is never sent back, so its field starts empty.
            type={field.secret ? "password" : "text"}
            defaultValue={field.secret ? undefined : saved?.settings[field.name]}
            required={!field.optional}
            maxLength={4096}
            autoComplete="off"
            spellCheck={false}
          />
        );
      })}
    </>
  );
}

interface DraftProblemProps {
  readonly kind: Kind;
  readonly failure: TargetFailure | null;
  readonly fallback: string;
}

/** Why the API refused a form of this file, with the label of the setting it names. */
function DraftProblem({ kind, failure, fallback }: DraftProblemProps) {
  const textOf = useFieldTexts(kind);
  return (
    <TargetFailureNote
      failure={failure}
      fallback={fallback}
      settingLabel={(name) => textOf(name).label}
    />
  );
}

interface SavedSettingsProps {
  readonly target: ConnectorDestination;
}

/** The settings of a destination. A secret shows that it is saved, never its value. */
function SavedSettings({ target }: SavedSettingsProps) {
  const { t } = useTranslation();
  const textOf = useFieldTexts(target.type);
  return (
    <ul className="grid gap-0.5 text-xs text-muted-foreground">
      {connectorOf(target.type).fields.map((field) => {
        const { label } = textOf(field.name);
        const value = target.settings[field.name];
        if (field.secret)
          return <li key={field.name}>{t("inbox.connectors.secretSaved", { label })}</li>;
        if (value === undefined) return null;
        return (
          <li key={field.name} className="wrap-anywhere">
            {t("inbox.connectors.setting", { label, value })}
          </li>
        );
      })}
    </ul>
  );
}

interface ConnectorTargetsProps {
  readonly inboxId: Inbox["id"];
  readonly form: Inbox["forms"][number];
}

/** The destinations of a form that a connector sends to, such as a Discord channel. */
export function ConnectorTargets({ inboxId, form }: ConnectorTargetsProps) {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<readonly ConnectorDestination[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [kind, setKind] = useState<Kind>("discord");
  const [editing, setEditing] = useState<ConnectorDestination["id"] | null>(null);
  // A form keeps what was typed when the API refuses it, and empties once saved.
  const [added, setAdded] = useState(0);
  const [addFailure, setAddFailure] = useState<TargetFailure | null>(null);
  const [editFailure, setEditFailure] = useState<TargetFailure | null>(null);
  const [saving, startSaving] = useTransition();

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the form's connector targets from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listTargets(inboxId, form.publicId, request.signal).then(
      (all) => setTargets(all.filter(isConnectorDestination)),
      () => {
        if (!request.signal.aborted) setFailed(true);
      },
    );
    return () => request.abort();
  }, [inboxId, form.publicId]);

  function replace(target: ConnectorDestination) {
    setTargets(
      (current) => current?.map((item) => (item.id === target.id ? target : item)) ?? null,
    );
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = draftIn(kind, new FormData(event.currentTarget));
    startSaving(async () => {
      const failure = await attempt(async () => {
        const created = await createConnectorTarget(inboxId, form.publicId, draft);
        setTargets((current) => [...(current ?? []), created]);
        setAdded((count) => count + 1);
      });
      setAddFailure(failure);
    });
  }

  function save(target: ConnectorDestination, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = draftIn(target.type, new FormData(event.currentTarget));
    startSaving(async () => {
      const failure = await attempt(async () => {
        replace(await replaceConnectorSettings(inboxId, target.id, draft));
        setEditing(null);
      });
      setEditFailure(failure);
    });
  }

  const [actionFailure, act, acting] = useActionState((_: TargetFailure | null, data: FormData) => {
    const target = targets?.find(({ id }) => id === data.get("target"));
    const action = data.get("action");
    if (target === undefined || (action !== "activate" && action !== "deactivate")) return null;
    return attempt(async () => {
      const next = await setTargetActive(inboxId, target.id, action);
      if (isConnectorDestination(next)) replace(next);
    });
  }, null);

  return (
    <Card aria-label={t("inbox.connectors.label", { name: form.name })}>
      <CardHeader>
        <CardTitle>{t("inbox.connectors.title")}</CardTitle>
        <CardDescription>{t("inbox.connectors.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {failed && <FormProblem>{t("inbox.connectors.loadFailed")}</FormProblem>}
        {targets === null && !failed && (
          <output className="text-sm text-muted-foreground">{t("inbox.connectors.loading")}</output>
        )}
        {targets?.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("inbox.connectors.empty")}</p>
        )}
        {targets !== null && targets.length > 0 && (
          <ul className="grid gap-px overflow-hidden rounded-md bg-border shadow-raised">
            {targets.map((target) => (
              <li key={target.id} className="grid gap-2 bg-card px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <p className="min-w-0 flex-1 basis-56 text-sm font-medium wrap-anywhere">
                    {target.name}
                  </p>
                  <Badge variant="neutral">{connectorOf(target.type).label}</Badge>
                  <Badge variant={target.active ? "success" : "neutral"}>
                    {target.active ? t("inbox.connectors.active") : t("inbox.connectors.inactive")}
                  </Badge>
                </div>
                {editing === target.id ? (
                  <form onSubmit={(event) => save(target, event)} className="grid gap-3">
                    <p className="text-xs text-pretty text-muted-foreground">
                      {t("inbox.connectors.secretAgain")}
                    </p>
                    <NameField initial={target.name} />
                    <SettingFields kind={target.type} saved={target} />
                    <DraftProblem
                      kind={target.type}
                      failure={editFailure}
                      fallback={t("inbox.destinations.notSaved")}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" size="sm" variant="default" disabled={saving}>
                        {t("common.save")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <SavedSettings target={target} />
                    <div className="flex flex-wrap items-center gap-2">
                      <TargetTest inboxId={inboxId} targetId={target.id} />
                      <Button
                        size="sm"
                        onClick={() => {
                          setEditFailure(null);
                          setEditing(target.id);
                        }}
                      >
                        {t("inbox.connectors.edit")}
                      </Button>
                      <form action={act} className="contents">
                        <input type="hidden" name="target" value={target.id} />
                        <Button
                          type="submit"
                          size="sm"
                          variant="ghost"
                          name="action"
                          value={target.active ? "deactivate" : "activate"}
                          disabled={acting}
                        >
                          {target.active
                            ? t("inbox.destinations.deactivate")
                            : t("inbox.destinations.reactivate")}
                        </Button>
                      </form>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <TargetFailureNote failure={actionFailure} fallback={t("inbox.destinations.notSaved")} />
        <form key={added} onSubmit={add} className="grid gap-3">
          <SelectField
            label={t("inbox.connectors.service")}
            hint={t(`inbox.connectors.types.${kind}.about`)}
            className="max-w-xs"
            value={kind}
            onChange={(event) => {
              if (isConnectorType(event.target.value)) setKind(event.target.value);
              setAddFailure(null);
            }}
          >
            {connectors.map((connector) => (
              <option key={connector.type} value={connector.type}>
                {connector.label}
              </option>
            ))}
          </SelectField>
          <NameField initial={undefined} />
          <SettingFields key={kind} kind={kind} saved={null} />
          <DraftProblem
            kind={kind}
            failure={addFailure}
            fallback={t("inbox.connectors.notAdded")}
          />
          <Button type="submit" className="justify-self-start" disabled={saving}>
            {t("inbox.connectors.add")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
