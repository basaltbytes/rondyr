import { Option, Schema } from "effect";
import { useActionState, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TurnstileKeyState } from "@rondyr/forms/turnstile";

import { FormProblem, TextField } from "~/components/text-field";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { checkTurnstileKey, FormRequestFailed, setTurnstile } from "~/lib/forms-client";
import type { Form, FormProblem as FormRequestProblem } from "~/lib/forms-client";
import type { Inbox } from "~/lib/inbox-client";

const isFailed = Schema.is(FormRequestFailed);

/** Why a save failed: the problem that the API names, or no stated reason. */
type SaveFailure = FormRequestProblem["error"] | "unexplained";

/** The answer of the key check, while it runs, or the failure of the request. */
type KeyCheck = TurnstileKeyState | "checking" | "requestFailed";

interface StoredKeyStateProps {
  readonly inboxId: Inbox["id"];
  readonly publicId: Form["publicId"];
}

/** Whether Cloudflare still accepts the stored secret key, checked on each display. */
function StoredKeyState({ inboxId, publicId }: StoredKeyStateProps) {
  const { t } = useTranslation();
  const [check, setCheck] = useState<KeyCheck>("checking");

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Asks the Rondyr API, which asks Cloudflare Siteverify, about the stored key.
  useEffect(() => {
    const request = new AbortController();
    void checkTurnstileKey(inboxId, publicId, request.signal).then(setCheck, () => {
      if (!request.signal.aborted) setCheck("requestFailed");
    });
    return () => request.abort();
  }, [inboxId, publicId]);

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
      <pre className="w-full min-w-0 overflow-x-auto rounded-md bg-muted px-4 py-3 text-xs">
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
  readonly inboxId: Inbox["id"];
  readonly form: Form;
  readonly onChanged: () => Promise<void>;
}

export function FormTurnstile({ inboxId, form, onChanged }: FormTurnstileProps) {
  const { t } = useTranslation();
  // Each save stores a new secret key, which the key state then checks again.
  const [saves, setSaves] = useState(0);
  const [result, save, saving] = useActionState(async (_: SaveFailure | null, data: FormData) => {
    const settings =
      data.get("action") === "clear"
        ? null
        : {
            siteKey: String(data.get("siteKey") ?? ""),
            secretKey: String(data.get("secretKey") ?? ""),
          };
    try {
      await setTurnstile(inboxId, form.publicId, settings);
      setSaves((count) => count + 1);
      await onChanged();
      return null;
    } catch (error) {
      if (!isFailed(error)) return "unexplained";
      return Option.match(error.problem, {
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("inbox.forms.turnstile.title")}</CardTitle>
        <CardDescription>{t("inbox.forms.turnstile.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          {siteKey !== null && (
            <StoredKeyState
              key={`${form.publicId}:${saves}`}
              inboxId={inboxId}
              publicId={form.publicId}
            />
          )}
          <form action={save} className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                key={siteKey}
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
              <Button type="submit" disabled={saving}>
                {saving ? t("inbox.forms.turnstile.saving") : t("inbox.forms.turnstile.save")}
              </Button>
              {siteKey !== null && (
                <Button
                  type="submit"
                  name="action"
                  value="clear"
                  variant="ghost"
                  formNoValidate
                  disabled={saving}
                >
                  {t("inbox.forms.turnstile.disable")}
                </Button>
              )}
            </div>
          </form>
          {siteKey !== null && <WidgetSnippet key={siteKey} siteKey={siteKey} />}
        </div>
      </CardContent>
    </Card>
  );
}
