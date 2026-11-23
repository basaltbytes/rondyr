import { useQuery } from "@tanstack/react-query";
import { Option } from "effect";
import { useActionState, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TurnstileKeyState } from "@rondyr/forms/turnstile";

import { FormProblem, TextField } from "~/components/text-field";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  formRefusalOf,
  turnstileKeyQuery,
  type FormChange,
  type FormRequestError,
  type ManagedForm,
} from "~/lib/api/forms";

/** Why a save failed: the problem that the API names, or no stated reason. */
type SaveFailure = FormRequestError["error"] | "unexplained";

/** The answer of the key check, while it runs, or the failure of the request. */
type KeyCheck = TurnstileKeyState | "checking" | "requestFailed";

interface StoredKeyStateProps {
  readonly organizationId: string;
  readonly publicId: ManagedForm["publicId"];
}

/**
 * Whether Cloudflare still accepts the stored secret key, checked on each display and
 * after each save, which stores a new key.
 */
function StoredKeyState({ organizationId, publicId }: StoredKeyStateProps) {
  const { t } = useTranslation();
  const keyCheck = useQuery(turnstileKeyQuery(organizationId, publicId));
  const check: KeyCheck = keyCheck.isFetching
    ? "checking"
    : keyCheck.isError
      ? "requestFailed"
      : (keyCheck.data ?? "checking");

  switch (check) {
    case "refused":
    case "unreadable":
      return (
        <Alert>
          <AlertTitle>{t("inbox.forms.turnstile.key.off")}</AlertTitle>
          <AlertDescription>
            {check === "refused"
              ? t("inbox.forms.turnstile.key.refused")
              : t("inbox.forms.turnstile.key.unreadable")}
          </AlertDescription>
        </Alert>
      );
    case "checking":
      return (
        <output className="text-sm text-muted-foreground">
          {t("inbox.forms.turnstile.key.checking")}
        </output>
      );
    case "working":
      return (
        <p className="text-sm text-pretty text-muted-foreground">
          {t("inbox.forms.turnstile.key.working")}
        </p>
      );
    case "unchecked":
      return (
        <p className="text-sm text-pretty text-muted-foreground">
          {t("inbox.forms.turnstile.key.unchecked")}
        </p>
      );
    case "requestFailed":
      return (
        <p className="text-sm text-pretty text-muted-foreground">
          {t("inbox.forms.turnstile.key.requestFailed")}
        </p>
      );
  }
}

function WidgetSnippet({ siteKey }: { readonly siteKey: string }) {
  const { t } = useTranslation();
  const [copy, setCopy] = useState<"copied" | "copyFailed" | null>(null);
  const snippet = [
    '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>',
    `<div class="cf-turnstile" data-sitekey="${siteKey}"></div>`,
  ].join("\n");

  return (
    <div className="grid justify-items-start gap-2">
      <p className="text-sm text-muted-foreground">{t("inbox.forms.turnstile.embed")}</p>
      <pre className="w-full min-w-0 rounded-md bg-muted px-4 py-3 text-xs wrap-anywhere whitespace-pre-wrap">
        <code>{snippet}</code>
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(snippet);
              setCopy("copied");
            } catch {
              setCopy("copyFailed");
            }
          }}
        >
          {t("inbox.forms.turnstile.copy")}
        </Button>
        <output className="text-sm text-muted-foreground">
          {copy === "copied" && t("inbox.forms.turnstile.copied")}
          {copy === "copyFailed" && t("inbox.forms.turnstile.copyFailed")}
        </output>
      </div>
    </div>
  );
}

interface FormTurnstileProps {
  readonly organizationId: string;
  readonly form: ManagedForm;
  /** Sends a change of the form, then reads the organizations again. */
  readonly onChange: (change: FormChange) => Promise<ManagedForm>;
}

/**
 * Turnstile on a form: off with a way to set it up, both keys while they are
 * typed, and once on, the state of the stored key and the HTML of the widget.
 */
export function FormTurnstile({ organizationId, form, onChange }: FormTurnstileProps) {
  const { t } = useTranslation();
  const [configuring, setConfiguring] = useState(false);
  const [result, save, saving] = useActionState(async (_: SaveFailure | null, data: FormData) => {
    const keys =
      data.get("action") === "clear"
        ? null
        : {
            siteKey: String(data.get("siteKey") ?? ""),
            secretKey: String(data.get("secretKey") ?? ""),
          };
    try {
      await onChange({ change: "turnstile", keys });
      setConfiguring(false);
      return null;
    } catch (cause) {
      return Option.match(formRefusalOf(cause), {
        onNone: (): SaveFailure => "unexplained",
        onSome: (problem): SaveFailure => problem.error,
      });
    }
  }, null);
  const siteKey = form.turnstileSiteKey;

  function explain(failure: SaveFailure) {
    switch (failure) {
      case "secrets-key-missing":
        return t("inbox.forms.turnstile.secretsKeyMissing");
      case "turnstile-secret-refused":
        return t("inbox.forms.turnstile.secretKeyRefused");
      case "siteverify-unavailable":
        return t("inbox.forms.turnstile.siteverifyUnavailable");
      case "success-url-refused":
      case "unexplained":
        return t("inbox.forms.turnstile.saveFailed");
    }
  }

  if (configuring) {
    return (
      <form action={save} className="grid gap-3 rounded-md bg-muted p-4">
        <p className="text-xs text-pretty text-muted-foreground">
          {t("inbox.forms.turnstile.description")}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            name="siteKey"
            label={t("inbox.forms.turnstile.siteKey")}
            defaultValue={siteKey ?? ""}
            maxLength={256}
            pattern={"[a-zA-Z0-9_\\-]+"}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <TextField
            type="password"
            name="secretKey"
            label={t("inbox.forms.turnstile.secretKey")}
            maxLength={256}
            autoComplete="new-password"
            required
          />
        </div>
        <FormProblem>{result === null ? null : explain(result)}</FormProblem>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="default" disabled={saving}>
            {saving ? t("inbox.forms.turnstile.saving") : t("inbox.forms.turnstile.save")}
          </Button>
          <Button variant="ghost" disabled={saving} onClick={() => setConfiguring(false)}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    );
  }

  if (siteKey === null) {
    return (
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2">
        <Badge>{t("inbox.forms.turnstile.off")}</Badge>
        <span className="min-w-0 flex-1 basis-40 text-sm text-pretty text-muted-foreground">
          {t("inbox.forms.turnstile.key.off")}
        </span>
        <Button size="sm" onClick={() => setConfiguring(true)}>
          {t("inbox.forms.turnstile.configure")}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <form action={save} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2">
        <Badge variant="success">{t("inbox.forms.turnstile.on")}</Badge>
        <span className="min-w-0 flex-1 basis-40" />
        <Button size="sm" disabled={saving} onClick={() => setConfiguring(true)}>
          {t("inbox.forms.turnstile.configure")}
        </Button>
        <Button
          type="submit"
          name="action"
          value="clear"
          variant="ghost"
          size="sm"
          disabled={saving}
        >
          {t("inbox.forms.turnstile.disable")}
        </Button>
      </form>
      <FormProblem>{result === null ? null : explain(result)}</FormProblem>
      <StoredKeyState organizationId={organizationId} publicId={form.publicId} />
      <WidgetSnippet key={siteKey} siteKey={siteKey} />
    </div>
  );
}
