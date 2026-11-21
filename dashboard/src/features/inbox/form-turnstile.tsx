import { Option, Schema } from "effect";
import { useActionState, useState } from "react";
import { useTranslation } from "react-i18next";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { FormRequestFailed, setTurnstile } from "~/lib/forms-client";
import type { Form, FormProblem as FormRequestProblem } from "~/lib/forms-client";
import type { Inbox } from "~/lib/inbox-client";

const isFailed = Schema.is(FormRequestFailed);

/** Why a save failed: the problem that the API names, or no stated reason. */
type SaveFailure = FormRequestProblem["error"] | "unexplained";

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
      <pre className="w-full min-w-0 overflow-x-auto rounded-md bg-muted p-3 text-xs">
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
