import { Option, Schema } from "effect";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { useLanguage } from "~/lib/i18n";
import { PasswordResetFailed, requestPasswordReset } from "~/lib/password-reset-client";

const isFailed = Schema.is(PasswordResetFailed);

interface Outcome {
  readonly status: "sent" | "noProvider" | "failed";
  /** The address of the request. */
  readonly email: string;
}

interface PasswordResetRequestProps {
  /** Show the sign-in form again. */
  readonly onBack: () => void;
}

/** Ask for a link to choose a new password, from the sign-in screen. */
export function PasswordResetRequest({ onBack }: PasswordResetRequestProps) {
  const { t } = useTranslation();
  const language = useLanguage();
  const [outcome, request, pending] = useActionState(
    async (_: Outcome | null, data: FormData): Promise<Outcome> => {
      const email = data.get("email")?.toString().trim() ?? "";
      try {
        await requestPasswordReset(email, language);
        return { status: "sent", email };
      } catch (error) {
        if (
          isFailed(error) &&
          Option.isSome(error.problem) &&
          error.problem.value.error === "email-provider-missing"
        ) {
          return { status: "noProvider", email };
        }
        return { status: "failed", email };
      }
    },
    null,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("authentication.passwordReset.title")}</CardTitle>
        <CardDescription>{t("authentication.passwordReset.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={request} className="grid gap-4">
          <TextField
            label={t("authentication.signIn.email")}
            type="email"
            name="email"
            autoComplete="username"
            required
          />
          <output className="text-sm text-pretty">
            {outcome?.status === "sent"
              ? t("authentication.passwordReset.sent", { email: outcome.email })
              : null}
          </output>
          <FormProblem>
            {outcome?.status === "noProvider"
              ? t("authentication.passwordReset.noProvider")
              : outcome?.status === "failed"
                ? t("authentication.passwordReset.failed")
                : null}
          </FormProblem>
          <div className="flex flex-wrap justify-between gap-2">
            <Button type="button" variant="ghost" onClick={onBack}>
              {t("authentication.passwordReset.back")}
            </Button>
            <Button type="submit" variant="default" disabled={pending}>
              {pending
                ? t("authentication.passwordReset.sending")
                : t("authentication.passwordReset.submit")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
