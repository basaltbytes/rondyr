import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Mails } from "lucide-react";
import { useActionState, useId, useState } from "react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";

import { TextAreaField, TextField } from "~/components/text-field";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { SidebarTrigger } from "~/components/ui/sidebar";
import {
  changeFormMutation,
  createFormMutation,
  type FormChange,
  type FormChanges,
  type ManagedForm,
} from "~/lib/api/forms";
import { messageCountsQuery } from "~/lib/api/messages";
import { countsOfForm, totalOf } from "~/lib/folder-counts";

import { AllowedOrigins } from "./allowed-origins.tsx";
import { EmojiPicker, emojiOf } from "~/components/form-emoji";
import { CopyButton, Field, SavingInput } from "./form-field.tsx";
import { attempt, FormFailureNote } from "./form-problems.tsx";
import type { FormFailure } from "./form-problems.tsx";
import { FormTurnstile } from "./form-turnstile.tsx";

// The element of a field name inside a translated sentence.
const code = <code className="font-mono wrap-anywhere" />;

// A text edited in place: it looks like the page's text until it is pointed at or focused.
const inPlace =
  "-mx-2 w-[calc(100%+1rem)] min-w-0 rounded-md bg-transparent px-2 transition-colors duration-150 ease-out hover:bg-muted focus:bg-muted disabled:opacity-50";

interface PageBarProps {
  readonly title: string;
  /** A control at the end of the bar. */
  readonly children?: ReactNode;
}

/** The bar of a page of forms: the menu button, then where the page is. */
function PageBar({ title, children }: PageBarProps) {
  const { t } = useTranslation();
  return (
    <header className="sticky top-0 z-10 flex h-14 items-center gap-1 bg-background hairline-b pr-3 pl-1">
      <SidebarTrigger />
      <p className="flex min-w-0 flex-1 items-center gap-2 px-1 text-sm text-muted-foreground">
        <span className="shrink-0">{t("inbox.sections.forms")}</span>
        <span aria-hidden="true">/</span>
        <span className="truncate text-foreground">{title}</span>
      </p>
      {children}
    </header>
  );
}

interface FormStatusFieldProps {
  readonly form: ManagedForm;
  /** Sends a change of the form, then reads the organizations again. */
  readonly onChange: (change: FormChange) => Promise<ManagedForm>;
}

/** Whether the form takes messages. Suspending it asks for a confirmation first. */
function FormStatusField({ form, onChange }: FormStatusFieldProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [failure, change, changing] = useActionState((_: FormFailure | null, data: FormData) => {
    const action = data.get("action");
    if (action !== "suspend" && action !== "reactivate") return null;
    return attempt(async () => {
      await onChange({ change: "status", action });
      setConfirming(false);
    });
  }, null);

  return (
    <Field label={t("inbox.forms.status")} hint={t("inbox.forms.suspension.description")}>
      <form action={change} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2">
        <Badge variant={form.status === "active" ? "success" : "neutral"}>
          {t(`inbox.forms.statuses.${form.status}`)}
        </Badge>
        <span className="flex flex-1 flex-wrap justify-end gap-2">
          {form.status === "active" && !confirming && (
            <Button size="sm" onClick={() => setConfirming(true)}>
              {t("inbox.forms.suspension.suspend")}
            </Button>
          )}
          {form.status === "active" && confirming && (
            <>
              <Button
                type="submit"
                size="sm"
                variant="default"
                name="action"
                value="suspend"
                disabled={changing}
              >
                {t("inbox.forms.suspension.confirm")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
            </>
          )}
          {form.status === "suspended" && (
            <Button
              type="submit"
              size="sm"
              variant="default"
              name="action"
              value="reactivate"
              disabled={changing}
            >
              {t("inbox.forms.suspension.reactivate")}
            </Button>
          )}
        </span>
      </form>
      <FormFailureNote failure={failure} fallback={t("inbox.forms.problems.statusNotChanged")} />
    </Field>
  );
}

interface FormPageProps {
  readonly organizationId: string;
  readonly form: ManagedForm;
  /** Where the accepted messages of the form go, which another feature shows. */
  readonly destinations: ReactNode;
}

/**
 * Everything about one form on one page: its emoji, its name and its business
 * at the top, edited in place; its settings as fields; then its destinations
 * and its allowed origins side by side.
 */
export function FormPage({ organizationId, form, destinations }: FormPageProps) {
  const { t } = useTranslation();
  const ids = useId();
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [saving, setSaving] = useState(false);
  const { mutateAsync: onChange } = useMutation(changeFormMutation(organizationId, form.publicId));
  const { data: counts } = useQuery(messageCountsQuery(organizationId));
  const messages =
    counts === undefined ? null : totalOf(countsOfForm(counts, form.publicId), "all");
  const publicUrl = `${window.location.origin}/f/${encodeURIComponent(form.publicId)}`;

  async function change(details: FormChanges) {
    setSaving(true);
    const failed = await attempt(async () => {
      await onChange({ change: "details", details });
    });
    setFailure(failed);
    setSaving(false);
  }

  const save = (formChange: FormChange) =>
    attempt(async () => {
      await onChange(formChange);
    });

  return (
    <main className="isolate min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <PageBar title={form.name}>
        <Link
          to="/o/$organizationId/messages"
          params={{ organizationId }}
          search={{ folder: "all", form: form.publicId }}
          aria-label={t("inbox.forms.messages", { name: form.name })}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <Mails aria-hidden="true" className="size-4" />
          {t("inbox.navigation.messages")}
          {messages !== null && <span className="tabular-nums">{messages}</span>}
        </Link>
      </PageBar>
      <section
        aria-label={t("inbox.forms.settings", { name: form.name })}
        className="mx-auto max-w-4xl px-5 pt-8 pb-16 sm:px-8"
      >
        <div className="-ml-2">
          <EmojiPicker
            size="lg"
            value={emojiOf(form)}
            disabled={saving}
            onChange={(emoji) => void change({ emoji })}
          />
        </div>
        <h1 className="mt-2">
          <input
            // The field shows the saved name again once the form is read anew.
            key={form.name}
            aria-label={t("inbox.forms.name")}
            defaultValue={form.name}
            required
            maxLength={100}
            autoComplete="off"
            disabled={saving}
            className={`${inPlace} h-12 text-2xl font-semibold tracking-tight sm:text-3xl`}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            onBlur={(event) => {
              const name = event.currentTarget.value.trim();
              // A form keeps a name: an emptied field takes the saved one back.
              if (name === "") event.currentTarget.value = form.name;
              else if (name !== form.name) void change({ name });
            }}
          />
        </h1>
        <textarea
          key={form.businessContext ?? ""}
          aria-label={t("inbox.business.label")}
          defaultValue={form.businessContext ?? ""}
          placeholder={t("inbox.forms.businessPlaceholder")}
          rows={2}
          maxLength={2000}
          disabled={saving}
          className={`${inPlace} mt-1 field-sizing-content resize-none py-1.5 text-base text-pretty text-muted-foreground placeholder:text-muted-foreground/70 focus:text-foreground pointer-fine:text-sm`}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.currentTarget.blur();
            }
          }}
          onBlur={(event) => {
            const businessContext = event.currentTarget.value.trim();
            if (businessContext !== (form.businessContext ?? "")) void change({ businessContext });
          }}
        />
        <FormFailureNote failure={failure} fallback={t("inbox.forms.problems.notChanged")} />

        <div className="mt-8 grid gap-5">
          <Field
            label={t("inbox.forms.address.title")}
            hint={
              form.status === "suspended"
                ? t("inbox.forms.address.suspended")
                : t("inbox.forms.address.active")
            }
          >
            <div className="flex min-h-10 items-center gap-2 rounded-md border border-border bg-input py-1 pr-1 pl-4">
              <code className="min-w-0 flex-1 font-mono text-sm wrap-anywhere">{publicUrl}</code>
              <CopyButton
                text={publicUrl}
                label={t("inbox.forms.address.copy")}
                copiedLabel={t("inbox.forms.address.copied")}
              />
            </div>
          </Field>
          <FormStatusField form={form} onChange={onChange} />
          <Field
            label={t("inbox.forms.redirect.url")}
            htmlFor={`${ids}-redirect`}
            hintId={`${ids}-redirect-hint`}
            hint={
              form.successUrl === null
                ? t("inbox.forms.redirect.confirmationPage")
                : t("inbox.forms.redirect.redirects")
            }
          >
            <SavingInput
              id={`${ids}-redirect`}
              hintId={`${ids}-redirect-hint`}
              type="url"
              value={form.successUrl}
              placeholder={t("inbox.forms.redirect.placeholder")}
              maxLength={2048}
              fallback={t("inbox.forms.problems.redirectNotSaved")}
              onSave={(url) => save({ change: "successUrl", url })}
            />
          </Field>
          <Field
            label={t("inbox.forms.honeypot.name")}
            htmlFor={`${ids}-honeypot`}
            hintId={`${ids}-honeypot-hint`}
            hint={<Trans i18nKey="inbox.forms.honeypot.instructions" components={{ code }} />}
          >
            <SavingInput
              id={`${ids}-honeypot`}
              hintId={`${ids}-honeypot-hint`}
              value={form.honeypotField}
              placeholder={t("inbox.forms.honeypot.placeholder")}
              maxLength={100}
              fallback={t("inbox.forms.problems.honeypotNotSaved")}
              onSave={(field) => save({ change: "honeypot", field })}
            />
          </Field>
          <Field label={t("inbox.forms.turnstile.title")}>
            <FormTurnstile organizationId={organizationId} form={form} onChange={onChange} />
          </Field>
        </div>

        <div className="mt-12 grid gap-10 lg:grid-cols-2">
          {destinations}
          <AllowedOrigins
            key={`origins-${form.publicId}`}
            organizationId={organizationId}
            form={form}
          />
        </div>
      </section>
    </main>
  );
}

interface NewFormPageProps {
  readonly organizationId: string;
  /** Open the page of the new form, once the organizations are read again. */
  readonly onCreated: (publicId: ManagedForm["publicId"]) => Promise<void>;
}

/** Adds a form to the organization: its emoji, its name and its business. */
export function NewFormPage({ organizationId, onCreated }: NewFormPageProps) {
  const { t } = useTranslation();
  const [emoji, setEmoji] = useState<string | null>(null);
  const { mutateAsync: create } = useMutation(createFormMutation(organizationId));
  const [failure, add, adding] = useActionState(
    (_: FormFailure | null, data: FormData) =>
      attempt(async () => {
        const created = await create({
          name: data.get("name")?.toString() ?? "",
          emoji,
          businessContext: data.get("businessContext")?.toString() ?? "",
        });
        await onCreated(created.publicId);
      }),
    null,
  );

  return (
    <main className="isolate min-w-0 lg:col-span-2 lg:overflow-y-auto">
      <PageBar title={t("inbox.forms.newTitle")} />
      <form action={add} className="mx-auto grid max-w-xl gap-4 px-5 pt-8 pb-16">
        <h1 className="text-lg font-semibold">{t("inbox.forms.newTitle")}</h1>
        <p className="text-sm text-pretty text-muted-foreground">{t("inbox.forms.details.new")}</p>
        <div className="flex items-end gap-2">
          <EmojiPicker value={emojiOf({ emoji })} onChange={setEmoji} />
          <TextField
            label={t("inbox.forms.name")}
            className="min-w-0 flex-1"
            name="name"
            required
            maxLength={100}
          />
        </div>
        <TextAreaField
          label={t("inbox.business.label")}
          name="businessContext"
          maxLength={2000}
          hint={t("inbox.business.hint")}
        />
        <FormFailureNote failure={failure} fallback={t("inbox.forms.problems.notAdded")} />
        <Button type="submit" variant="default" className="justify-self-start" disabled={adding}>
          {t("inbox.forms.add")}
        </Button>
      </form>
    </main>
  );
}
