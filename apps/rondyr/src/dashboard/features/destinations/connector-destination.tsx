import { Option, Schema } from "effect";
import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { connectorOf } from "@rondyr/deliveries/connectors/catalog";

import { TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import type { Inbox } from "~/lib/inbox-client";
import { replaceConnectorSettings } from "~/lib/targets-client";
import type { ConnectorDestination, ConnectorDraft } from "~/lib/targets-client";

import { attempt, DestinationFailureNote } from "./destination-problems.tsx";
import type { DestinationFailure } from "./destination-problems.tsx";
import { DestinationTest } from "./destination-test.tsx";

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

/** The name and the settings typed in a form of a connector. */
export function draftIn(kind: Kind, data: FormData): ConnectorDraft {
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
export function NameField({ initial }: NameFieldProps) {
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
export function SettingFields({ kind, saved }: SettingFieldsProps) {
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
  readonly failure: DestinationFailure | null;
  readonly fallback: string;
}

/** Why the API refused a form of a connector, with the label of the setting it names. */
export function DraftProblem({ kind, failure, fallback }: DraftProblemProps) {
  const textOf = useFieldTexts(kind);
  return (
    <DestinationFailureNote
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

interface ConnectorPanelProps {
  readonly inboxId: Inbox["id"];
  readonly target: ConnectorDestination;
  readonly onReplaced: (target: ConnectorDestination) => void;
}

/** What an open connector destination shows: its settings, their edition and a test. */
export function ConnectorPanel({ inboxId, target, onReplaced }: ConnectorPanelProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  // The form keeps what was typed when the API refuses it.
  const [failure, setFailure] = useState<DestinationFailure | null>(null);
  const [saving, startSaving] = useTransition();

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = draftIn(target.type, new FormData(event.currentTarget));
    startSaving(async () => {
      const failed = await attempt(async () => {
        onReplaced(await replaceConnectorSettings(inboxId, target.id, draft));
        setEditing(false);
      });
      setFailure(failed);
    });
  }

  return (
    <>
      <p className="text-xs text-pretty text-muted-foreground">
        {t("inbox.connectors.description")}
      </p>
      {editing ? (
        <form onSubmit={save} className="grid gap-3">
          <p className="text-xs text-pretty text-muted-foreground">
            {t("inbox.connectors.secretAgain")}
          </p>
          <NameField initial={target.name} />
          <SettingFields kind={target.type} saved={target} />
          <DraftProblem
            kind={target.type}
            failure={failure}
            fallback={t("inbox.destinations.notSaved")}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="default" disabled={saving}>
              {t("common.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <SavedSettings target={target} />
          <div className="flex flex-wrap items-center gap-2">
            <DestinationTest inboxId={inboxId} targetId={target.id} />
            <Button
              size="sm"
              onClick={() => {
                setFailure(null);
                setEditing(true);
              }}
            >
              {t("inbox.connectors.edit")}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
