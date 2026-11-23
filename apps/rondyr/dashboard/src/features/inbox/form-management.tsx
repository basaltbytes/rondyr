import { Option, Schema } from "effect";
import { useActionState, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import { FormProblem, TextAreaField, TextField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

import {
  clearHoneypotField,
  clearSuccessUrl,
  createForm,
  FormRequestFailed,
  setFormStatus,
  setHoneypotField,
  setSuccessUrl,
  updateForm,
} from "~/lib/forms-client";
import type { Form, FormProblem as FormRequestProblem } from "~/lib/forms-client";
import type { Inbox } from "~/lib/inbox-client";

import { FormTurnstile } from "./form-turnstile.tsx";

const isFailed = Schema.is(FormRequestFailed);

/** Why a request to the forms API failed: the problem that the API names, or no stated reason. */
type FormFailure = FormRequestProblem | "unexplained";

/** Run a request and return why it failed, or null. */
async function attempt(request: () => Promise<void>): Promise<FormFailure | null> {
  try {
    await request();
    return null;
  } catch (error) {
    if (!isFailed(error)) return "unexplained";
    return Option.match(error.problem, {
      onNone: (): FormFailure => "unexplained",
      onSome: (problem): FormFailure => problem,
    });
  }
}

interface FormFailureNoteProps {
  readonly failure: FormFailure | null;
  /** The message for a failure that the API does not explain. */
  readonly fallback: string;
}

function FormFailureNote({ failure, fallback }: FormFailureNoteProps) {
  const { t } = useTranslation();
  if (failure === null) return null;
  return (
    <FormProblem>
      {failure !== "unexplained" && failure.error === "success-url-refused"
        ? t(`inbox.forms.redirect.refusals.${failure.reason}`)
        : fallback}
    </FormProblem>
  );
}

// The element of a field name or of an address inside a translated sentence.
const code = <code className="font-mono wrap-anywhere" />;

function text(data: FormData, name: string) {
  return data.get(name)?.toString() ?? "";
}

interface FormSettingsProps {
  readonly inboxId: Inbox["id"];
  readonly form: Form;
  readonly onChanged: () => Promise<void>;
}

/** One form: public URL, name, business context, redirect, honeypot field and status. */
export function FormSettings({ inboxId, form, onChanged }: FormSettingsProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const publicUrl = `${window.location.origin}/f/${encodeURIComponent(form.publicId)}`;

  const [editFailure, edit, saving] = useActionState(
    (_: FormFailure | null, data: FormData) =>
      attempt(async () => {
        await updateForm(inboxId, form.publicId, text(data, "name"), text(data, "businessContext"));
        await onChanged();
        setEditing(false);
      }),
    null,
  );

  const [statusFailure, changeStatus, changing] = useActionState(
    (_: FormFailure | null, data: FormData) => {
      const action = data.get("action");
      if (action !== "suspend" && action !== "reactivate") return null;
      return attempt(async () => {
        await setFormStatus(inboxId, form.publicId, action);
        await onChanged();
        setConfirming(false);
      });
    },
    null,
  );

  const [redirectFailure, changeRedirect, redirecting] = useActionState(
    (_: FormFailure | null, data: FormData) => {
      const clear = data.get("action") === "clear";
      return attempt(async () => {
        if (clear) await clearSuccessUrl(inboxId, form.publicId);
        else await setSuccessUrl(inboxId, form.publicId, text(data, "url"));
        await onChanged();
      });
    },
    null,
  );

  const [honeypotFailure, changeHoneypot, trapping] = useActionState(
    (_: FormFailure | null, data: FormData) => {
      const clear = data.get("action") === "clear";
      return attempt(async () => {
        if (clear) await clearHoneypotField(inboxId, form.publicId);
        else await setHoneypotField(inboxId, form.publicId, text(data, "field"));
        await onChanged();
      });
    },
    null,
  );

  return (
    <section className="grid gap-4" aria-label={t("inbox.forms.settings", { name: form.name })}>
      <Card>
        <CardHeader>
          <CardTitle>{t("inbox.forms.address.title")}</CardTitle>
          <CardDescription>
            {form.status === "suspended"
              ? t("inbox.forms.address.suspended")
              : t("inbox.forms.address.active")}
          </CardDescription>
          <CardAction>
            <Badge variant={form.status === "active" ? "success" : "neutral"}>
              {t(`inbox.forms.statuses.${form.status}`)}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 basis-64 rounded-md bg-muted px-4 py-2.5 font-mono text-sm wrap-anywhere">
              {publicUrl}
            </code>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(publicUrl).then(() => setCopied(true));
              }}
            >
              {copied ? t("inbox.forms.address.copied") : t("inbox.forms.address.copy")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("inbox.forms.details.title")}</CardTitle>
          <CardDescription>
            {form.businessContext ?? t("inbox.forms.details.noBusiness")}
          </CardDescription>
          {!editing && (
            <CardAction>
              <Button size="sm" onClick={() => setEditing(true)}>
                {t("inbox.forms.edit")}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        {editing && (
          <CardContent>
            <form action={edit} className="grid gap-4">
              <TextField
                label={t("inbox.forms.name")}
                name="name"
                required
                maxLength={100}
                defaultValue={form.name}
              />
              <TextAreaField
                label={t("inbox.business.label")}
                name="businessContext"
                maxLength={2000}
                defaultValue={form.businessContext ?? ""}
                hint={t("inbox.business.hint")}
              />
              <FormFailureNote
                failure={editFailure}
                fallback={t("inbox.forms.problems.notChanged")}
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="default" disabled={saving}>
                  {t("common.save")}
                </Button>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </form>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("inbox.forms.redirect.title")}</CardTitle>
          <CardDescription>
            {form.successUrl === null ? (
              t("inbox.forms.redirect.confirmationPage")
            ) : (
              <Trans
                i18nKey="inbox.forms.redirect.successUrl"
                values={{ url: form.successUrl }}
                components={{ code }}
              />
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={changeRedirect} className="grid gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <TextField
                label={t("inbox.forms.redirect.url")}
                className="min-w-0 flex-1 basis-64"
                type="url"
                name="url"
                required
                maxLength={2048}
                placeholder={t("inbox.forms.redirect.placeholder")}
              />
              <Button type="submit" name="action" value="set" disabled={redirecting}>
                {t("inbox.forms.redirect.save")}
              </Button>
              {form.successUrl !== null && (
                <Button
                  type="submit"
                  variant="ghost"
                  name="action"
                  value="clear"
                  formNoValidate
                  disabled={redirecting}
                >
                  {t("inbox.forms.redirect.remove")}
                </Button>
              )}
            </div>
            <FormFailureNote
              failure={redirectFailure}
              fallback={t("inbox.forms.problems.redirectNotSaved")}
            />
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("inbox.forms.honeypot.title")}</CardTitle>
          <CardDescription>
            {form.honeypotField === null ? (
              <Trans i18nKey="inbox.forms.honeypot.none" components={{ code }} />
            ) : (
              <Trans
                i18nKey="inbox.forms.honeypot.current"
                values={{ field: form.honeypotField }}
                components={{ code }}
              />
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={changeHoneypot} className="grid gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <TextField
                label={t("inbox.forms.honeypot.name")}
                className="min-w-0 flex-1 basis-64"
                name="field"
                required
                maxLength={100}
                placeholder={t("inbox.forms.honeypot.placeholder")}
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" name="action" value="set" disabled={trapping}>
                {t("inbox.forms.honeypot.save")}
              </Button>
              {form.honeypotField !== null && (
                <Button
                  type="submit"
                  variant="ghost"
                  name="action"
                  value="clear"
                  formNoValidate
                  disabled={trapping}
                >
                  {t("inbox.forms.honeypot.remove")}
                </Button>
              )}
            </div>
            <FormFailureNote
              failure={honeypotFailure}
              fallback={t("inbox.forms.problems.honeypotNotSaved")}
            />
          </form>
        </CardContent>
      </Card>

      <FormTurnstile inboxId={inboxId} form={form} onChanged={onChanged} />

      <Card>
        <CardHeader>
          <CardTitle>
            {form.status === "active"
              ? t("inbox.forms.suspension.title")
              : t("inbox.forms.suspension.suspendedTitle")}
          </CardTitle>
          <CardDescription>{t("inbox.forms.suspension.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={changeStatus} className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {form.status === "active" && !confirming && (
                <Button onClick={() => setConfirming(true)}>
                  {t("inbox.forms.suspension.suspend")}
                </Button>
              )}
              {form.status === "active" && confirming && (
                <>
                  <Button
                    type="submit"
                    variant="default"
                    name="action"
                    value="suspend"
                    disabled={changing}
                  >
                    {t("inbox.forms.suspension.confirm")}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirming(false)}>
                    {t("common.cancel")}
                  </Button>
                </>
              )}
              {form.status === "suspended" && (
                <Button
                  type="submit"
                  variant="default"
                  name="action"
                  value="reactivate"
                  disabled={changing}
                >
                  {t("inbox.forms.suspension.reactivate")}
                </Button>
              )}
            </div>
            <FormFailureNote
              failure={statusFailure}
              fallback={t("inbox.forms.problems.statusNotChanged")}
            />
          </form>
        </CardContent>
      </Card>
    </section>
  );
}

interface NewFormProps {
  readonly inboxId: Inbox["id"];
  readonly onChanged: () => Promise<void>;
  /** The public identifier of the form once it exists. */
  readonly onCreated: (publicId: Form["publicId"]) => void;
}

/** Adds a form to the organization. */
export function NewForm({ inboxId, onChanged, onCreated }: NewFormProps) {
  const { t } = useTranslation();
  const [addFailure, add, adding] = useActionState(
    (_: FormFailure | null, data: FormData) =>
      attempt(async () => {
        const created = await createForm(
          inboxId,
          text(data, "name"),
          text(data, "businessContext"),
        );
        await onChanged();
        onCreated(created.publicId);
      }),
    null,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("inbox.forms.details.title")}</CardTitle>
        <CardDescription>{t("inbox.forms.details.new")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={add} className="grid gap-4">
          <TextField label={t("inbox.forms.name")} name="name" required maxLength={100} />
          <TextAreaField
            label={t("inbox.business.label")}
            name="businessContext"
            maxLength={2000}
            hint={t("inbox.business.hint")}
          />
          <FormFailureNote failure={addFailure} fallback={t("inbox.forms.problems.notAdded")} />
          <Button type="submit" variant="default" className="justify-self-start" disabled={adding}>
            {t("inbox.forms.add")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
