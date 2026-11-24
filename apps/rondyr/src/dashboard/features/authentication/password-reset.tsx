import { useMutation } from "@tanstack/react-query";
import { Option } from "effect";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { accountPasswordLength } from "@rondyr/organizations/account";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { completePasswordReset, passwordResetRefusalOf } from "~/lib/api/password-resets";
import { statusOf } from "~/lib/api/request";

type Outcome = "changed" | "invalid" | "rejected" | "failed";

interface PasswordResetProps {
  /** The secret of the link, from the fragment of its URL. */
  readonly token: string;
}

/** The page of a reset link: choose a new password, which signs the account out everywhere. */
export function PasswordReset({ token }: PasswordResetProps) {
  const { t } = useTranslation();
  const { mutateAsync: complete } = useMutation({
    mutationFn: (password: string) => completePasswordReset(token, password),
  });
  const [outcome, save, saving] = useActionState(
    async (_: Outcome | null, data: FormData): Promise<Outcome> => {
      const password = data.get("password")?.toString() ?? "";
      try {
        await complete(password);
        return "changed";
      } catch (cause) {
        const refusal = passwordResetRefusalOf(cause);
        if (Option.isSome(refusal) && refusal.value.error === "reset-invalid") return "invalid";
        return statusOf(cause) === 400 ? "rejected" : "failed";
      }
    },
    null,
  );

  if (outcome === "changed" || outcome === "invalid") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            {outcome === "changed"
              ? t("passwordReset.changed.title")
              : t("passwordReset.invalid.title")}
          </CardTitle>
          <CardDescription>
            {outcome === "changed"
              ? t("passwordReset.changed.body")
              : t("passwordReset.invalid.body")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <a href="/" className="text-sm font-medium underline underline-offset-4">
            {t("passwordReset.signIn")}
          </a>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("passwordReset.title")}</CardTitle>
        <CardDescription>{t("passwordReset.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={save} className="grid gap-4">
          <TextField
            label={t("passwordReset.password")}
            hint={t("passwordReset.passwordHint", {
              minimum: accountPasswordLength.minimum,
              maximum: accountPasswordLength.maximum,
            })}
            type="password"
            name="password"
            autoComplete="new-password"
            minLength={accountPasswordLength.minimum}
            maxLength={accountPasswordLength.maximum}
            required
          />
          <FormProblem>
            {outcome === "rejected"
              ? t("passwordReset.rejected", {
                  minimum: accountPasswordLength.minimum,
                  maximum: accountPasswordLength.maximum,
                })
              : outcome === "failed"
                ? t("passwordReset.failed")
                : null}
          </FormProblem>
          <Button type="submit" variant="default" disabled={saving}>
            {saving ? t("passwordReset.saving") : t("passwordReset.submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
