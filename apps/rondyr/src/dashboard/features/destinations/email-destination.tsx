import { Schema } from "effect";
import { useActionState, useState } from "react";
import { useTranslation } from "react-i18next";

import { SelectField, TextAreaField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { Inbox } from "~/lib/inbox-client";
import {
  destinationLanguages,
  isDestinationLanguage,
  replaceRecipients,
  resendConfirmation,
  TargetRequestFailed,
} from "~/lib/targets-client";
import type { EmailDestination } from "~/lib/targets-client";

import { attempt, DestinationFailureNote } from "./destination-problems.tsx";
import type { DestinationFailure } from "./destination-problems.tsx";
import { DestinationTest } from "./destination-test.tsx";

const isFailed = Schema.is(TargetRequestFailed);

/** What became of a new confirmation email. Each one names a message of `inbox.emails.resend`. */
type ResendOutcome = "sent" | "confirmed" | "limit" | "noProvider" | "failed";

function resendOutcomeOf(error: TargetRequestFailed | null): ResendOutcome {
  if (error?.status === 409) return "confirmed";
  if (error?.status === 429) return "limit";
  if (error?.status === 503) return "noProvider";
  return "failed";
}

interface RecipientsProps {
  readonly inboxId: Inbox["id"];
  readonly target: EmailDestination;
}

/**
 * The recipients of a destination, each `pending` until its owner confirms it
 * with the link that Rondyr emailed. Messages and tests go to confirmed ones only.
 */
function Recipients({ inboxId, target }: RecipientsProps) {
  const { t } = useTranslation();
  const [resent, resend, resending] = useActionState(
    async (_: { address: string; outcome: ResendOutcome } | null, data: FormData) => {
      const address = data.get("address")?.toString() ?? "";
      try {
        await resendConfirmation(inboxId, target.id, address);
        return { address, outcome: "sent" as const };
      } catch (error) {
        return { address, outcome: resendOutcomeOf(isFailed(error) ? error : null) };
      }
    },
    null,
  );

  return (
    <div className="grid gap-1.5">
      {target.recipientStatuses.map(({ address, status }) => (
        <form
          key={address}
          action={resend}
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
        >
          <span className="min-w-0 wrap-anywhere">{address}</span>
          <Badge variant={status === "confirmed" ? "success" : "neutral"}>
            {t(`inbox.emails.statuses.${status}`)}
          </Badge>
          {status === "pending" && (
            <>
              <input type="hidden" name="address" value={address} />
              <Button
                type="submit"
                size="sm"
                variant="ghost"
                disabled={resending}
                aria-label={t("inbox.emails.resendLabel", { address })}
              >
                {t("inbox.emails.resend.action")}
              </Button>
            </>
          )}
        </form>
      ))}
      {resent !== null && (
        <output className="text-xs text-pretty text-muted-foreground">
          {t(`inbox.emails.resend.${resent.outcome}`, { address: resent.address })}
        </output>
      )}
    </div>
  );
}

/** One address per line, or separated by commas or semicolons. */
export function addressesIn(data: FormData) {
  const text = data.get("recipients")?.toString() ?? "";
  return text.split(/[\s,;]+/u).filter((address) => address !== "");
}

/** The language picked in a form, if the form has a valid one. */
export function languageIn(data: FormData) {
  const language = data.get("language");
  return isDestinationLanguage(language) ? language : undefined;
}

interface LanguageFieldProps {
  /** The language that the field shows first. */
  readonly initial: EmailDestination["language"];
}

/** The language in which Rondyr writes the emails of a destination. */
export function LanguageField({ initial }: LanguageFieldProps) {
  const { t } = useTranslation();
  return (
    <SelectField
      label={t("inbox.emails.language")}
      className="max-w-xs"
      name="language"
      defaultValue={initial}
    >
      {destinationLanguages.map((language) => (
        <option key={language} value={language}>
          {t(`languages.${language}`)}
        </option>
      ))}
    </SelectField>
  );
}

interface EmailPanelProps {
  readonly inboxId: Inbox["id"];
  readonly target: EmailDestination;
  readonly onReplaced: (target: EmailDestination) => void;
}

/** What an open email destination shows: its recipients, its language, their edition and a test. */
export function EmailPanel({ inboxId, target, onReplaced }: EmailPanelProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [failure, save, saving] = useActionState((_: DestinationFailure | null, data: FormData) => {
    const recipients = addressesIn(data);
    const language = languageIn(data);
    return attempt(async () => {
      onReplaced(await replaceRecipients(inboxId, target.id, recipients, language));
      setEditing(false);
    });
  }, null);

  return (
    <>
      <p className="text-xs text-pretty text-muted-foreground">{t("inbox.emails.description")}</p>
      <p className="text-xs text-pretty text-muted-foreground">
        {t("inbox.emails.confirmationNote")}
      </p>
      <Recipients key={target.recipients.join(",")} inboxId={inboxId} target={target} />
      <p className="text-xs text-muted-foreground">
        {t("inbox.emails.languageValue", { language: t(`languages.${target.language}`) })}
      </p>
      {editing ? (
        <form action={save} className="grid gap-3">
          <TextAreaField
            label={t("inbox.emails.recipients")}
            name="recipients"
            required
            rows={3}
            defaultValue={target.recipients.join("\n")}
            autoComplete="off"
            spellCheck={false}
          />
          <LanguageField initial={target.language} />
          <DestinationFailureNote failure={failure} fallback={t("inbox.destinations.notSaved")} />
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
        <div className="flex flex-wrap items-center gap-2">
          <DestinationTest inboxId={inboxId} targetId={target.id} />
          <Button size="sm" onClick={() => setEditing(true)}>
            {t("inbox.emails.editRecipients")}
          </Button>
        </div>
      )}
    </>
  );
}
