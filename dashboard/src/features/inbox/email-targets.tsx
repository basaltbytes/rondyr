import { Schema } from "effect";
import { useActionState, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { FormProblem, SelectField, TextAreaField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useLanguage } from "~/lib/i18n";
import type { Inbox } from "~/lib/inbox-client";
import {
  createEmailTarget,
  destinationLanguages,
  isDestinationLanguage,
  isEmailDestination,
  listTargets,
  replaceRecipients,
  resendConfirmation,
  setTargetActive,
  TargetRequestFailed,
} from "~/lib/targets-client";
import type { EmailDestination } from "~/lib/targets-client";

import { attempt, TargetFailureNote } from "./target-problems.tsx";
import type { TargetFailure } from "./target-problems.tsx";
import { TargetTest } from "./target-test.tsx";

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
function addressesIn(data: FormData) {
  const text = data.get("recipients")?.toString() ?? "";
  return text.split(/[\s,;]+/u).filter((address) => address !== "");
}

/** The language picked in a form, if the form has a valid one. */
function languageIn(data: FormData) {
  const language = data.get("language");
  return isDestinationLanguage(language) ? language : undefined;
}

interface LanguageFieldProps {
  /** The language that the field shows first. */
  readonly initial: EmailDestination["language"];
}

/** The language in which Rondyr writes the emails of a destination. */
function LanguageField({ initial }: LanguageFieldProps) {
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

interface EmailTargetsProps {
  readonly inboxId: Inbox["id"];
  readonly form: Inbox["forms"][number];
}

export function EmailTargets({ inboxId, form }: EmailTargetsProps) {
  const { t } = useTranslation();
  const dashboardLanguage = useLanguage();
  const [targets, setTargets] = useState<readonly EmailDestination[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<EmailDestination["id"] | null>(null);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the form's email targets from the Rondyr API.
  useEffect(() => {
    const request = new AbortController();
    void listTargets(inboxId, form.publicId, request.signal).then(
      (all) => setTargets(all.filter(isEmailDestination)),
      () => {
        if (!request.signal.aborted) setFailed(true);
      },
    );
    return () => request.abort();
  }, [inboxId, form.publicId]);

  function replace(target: EmailDestination) {
    setTargets(
      (current) => current?.map((item) => (item.id === target.id ? target : item)) ?? null,
    );
  }

  const [addFailure, add, adding] = useActionState((_: TargetFailure | null, data: FormData) => {
    const recipients = addressesIn(data);
    const language = languageIn(data);
    return attempt(async () => {
      const created = await createEmailTarget(inboxId, form.publicId, recipients, language);
      setTargets((current) => [...(current ?? []), created]);
    });
  }, null);

  const [actionFailure, act, acting] = useActionState((_: TargetFailure | null, data: FormData) => {
    const target = targets?.find(({ id }) => id === data.get("target"));
    const action = data.get("action");
    if (target === undefined) return null;
    return attempt(async () => {
      if (action === "save") {
        replace(await replaceRecipients(inboxId, target.id, addressesIn(data), languageIn(data)));
        setEditing(null);
      } else if (action === "activate" || action === "deactivate") {
        const next = await setTargetActive(inboxId, target.id, action);
        if (isEmailDestination(next)) replace(next);
      }
    });
  }, null);

  return (
    <Card aria-label={t("inbox.emails.label", { name: form.name })}>
      <CardHeader>
        <CardTitle>{t("inbox.emails.title")}</CardTitle>
        <CardDescription>{t("inbox.emails.description")}</CardDescription>
        <CardDescription>{t("inbox.emails.confirmationNote")}</CardDescription>
      </CardHeader>
      <CardContent>
        {failed && <FormProblem>{t("inbox.emails.loadFailed")}</FormProblem>}
        {targets === null && !failed && (
          <output className="text-sm text-muted-foreground">{t("inbox.emails.loading")}</output>
        )}
        {targets?.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("inbox.emails.empty")}</p>
        )}
        {targets !== null && targets.length > 0 && (
          <ul className="grid gap-px overflow-hidden rounded-md bg-border shadow-raised">
            {targets.map((target) => (
              <li key={target.id} className="grid gap-2 bg-card px-3 py-3">
                <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                  <div className="min-w-0 flex-1 basis-56">
                    <Recipients
                      key={target.recipients.join(",")}
                      inboxId={inboxId}
                      target={target}
                    />
                  </div>
                  <Badge variant={target.active ? "success" : "neutral"}>
                    {target.active ? t("inbox.emails.active") : t("inbox.emails.inactive")}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("inbox.emails.languageValue", { language: t(`languages.${target.language}`) })}
                </p>
                {editing === target.id ? (
                  <form action={act} className="grid gap-3">
                    <input type="hidden" name="target" value={target.id} />
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
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="submit"
                        size="sm"
                        variant="default"
                        name="action"
                        value="save"
                        disabled={acting}
                      >
                        {t("common.save")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        {t("common.cancel")}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <TargetTest inboxId={inboxId} targetId={target.id} />
                    <Button size="sm" onClick={() => setEditing(target.id)}>
                      {t("inbox.emails.editRecipients")}
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
                )}
              </li>
            ))}
          </ul>
        )}
        <TargetFailureNote failure={actionFailure} fallback={t("inbox.destinations.notSaved")} />
        <form action={add} className="grid gap-3">
          <TextAreaField
            label={t("inbox.emails.recipients")}
            name="recipients"
            required
            rows={3}
            placeholder={t("inbox.emails.placeholder")}
            autoComplete="off"
            spellCheck={false}
          />
          {/* A new destination starts in the language of the dashboard. */}
          <LanguageField key={dashboardLanguage} initial={dashboardLanguage} />
          <TargetFailureNote failure={addFailure} fallback={t("inbox.emails.notAdded")} />
          <Button type="submit" className="justify-self-start" disabled={adding}>
            {t("inbox.emails.add")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
