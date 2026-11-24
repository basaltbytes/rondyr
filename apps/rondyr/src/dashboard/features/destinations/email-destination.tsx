import { useMutation } from "@tanstack/react-query";
import { useActionState, useState } from "react";
import { useTranslation } from "react-i18next";

import { SelectField, TextAreaField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  destinationLanguages,
  isDestinationLanguage,
  resendConfirmation,
  type DestinationChange,
  type EmailTarget,
  type SavedDestination,
} from "~/lib/api/destinations";
import { statusOf } from "~/lib/api/request";

import { attempt, DestinationFailureNote } from "./destination-problems.tsx";
import type { DestinationFailure } from "./destination-problems.tsx";
import { DestinationTest } from "./destination-test.tsx";

/** What became of a new confirmation email. Each one names a message of `inbox.emails.resend`. */
type ResendOutcome = "sent" | "confirmed" | "limit" | "noProvider" | "failed";

function resendOutcomeOf(status: number | null): ResendOutcome {
  if (status === 409) return "confirmed";
  if (status === 429) return "limit";
  if (status === 503) return "noProvider";
  return "failed";
}

interface RecipientsProps {
  readonly organizationId: string;
  readonly target: EmailTarget;
}

/**
 * The recipients of a destination, each `pending` until its owner confirms it
 * with the link that Rondyr emailed. Messages and tests go to confirmed ones only.
 */
function Recipients({ organizationId, target }: RecipientsProps) {
  const { t } = useTranslation();
  const { mutateAsync: sendAgain } = useMutation({
    mutationFn: (address: string) => resendConfirmation(organizationId, target.id, address),
  });
  const [resent, resend, resending] = useActionState(
    async (_: { address: string; outcome: ResendOutcome } | null, data: FormData) => {
      const address = data.get("address")?.toString() ?? "";
      try {
        await sendAgain(address);
        return { address, outcome: "sent" as const };
      } catch (cause) {
        return { address, outcome: resendOutcomeOf(statusOf(cause)) };
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
  readonly initial: EmailTarget["language"];
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
  readonly organizationId: string;
  readonly target: EmailTarget;
  /** Sends a change of the destination, then its cached copy. */
  readonly onChange: (change: DestinationChange) => Promise<SavedDestination>;
}

/** What an open email destination shows: its recipients, its language, their edition and a test. */
export function EmailPanel({ organizationId, target, onChange }: EmailPanelProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [failure, save, saving] = useActionState((_: DestinationFailure | null, data: FormData) => {
    const recipients = addressesIn(data);
    const language = languageIn(data);
    return attempt(async () => {
      await onChange({ change: "recipients", recipients, language });
      setEditing(false);
    });
  }, null);

  return (
    <>
      <p className="text-xs text-pretty text-muted-foreground">{t("inbox.emails.description")}</p>
      <p className="text-xs text-pretty text-muted-foreground">
        {t("inbox.emails.confirmationNote")}
      </p>
      <Recipients
        key={target.recipients.join(",")}
        organizationId={organizationId}
        target={target}
      />
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
          <DestinationTest organizationId={organizationId} targetId={target.id} />
          <Button size="sm" onClick={() => setEditing(true)}>
            {t("inbox.emails.editRecipients")}
          </Button>
        </div>
      )}
    </>
  );
}
