import { useActionState, useState } from "react";
import { useTranslation } from "react-i18next";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { authClient } from "~/lib/auth-client";

import { PasswordResetRequest } from "./password-reset-request.tsx";

type SignInProblem = "rateLimited" | "unavailable" | "refused" | "failed";

async function signIn(
  _previous: SignInProblem | null,
  fields: FormData,
): Promise<SignInProblem | null> {
  try {
    const result = await authClient.signIn.email({
      email: String(fields.get("email") ?? ""),
      password: String(fields.get("password") ?? ""),
    });

    if (result.error === null) return null;
    if (result.error.status === 429) return "rateLimited";
    if (result.error.status >= 500) return "unavailable";
    return "refused";
  } catch {
    return "failed";
  }
}

export function SignInForm() {
  const { t } = useTranslation();
  const [problem, action, pending] = useActionState(signIn, null);
  const [resetting, setResetting] = useState(false);

  if (resetting) return <PasswordResetRequest onBack={() => setResetting(false)} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("authentication.signIn.title")}</CardTitle>
        <CardDescription>{t("authentication.signIn.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="grid gap-4">
          <TextField
            label={t("authentication.signIn.email")}
            type="email"
            name="email"
            autoComplete="username"
            required
          />
          <TextField
            label={t("authentication.signIn.password")}
            type="password"
            name="password"
            autoComplete="current-password"
            required
          />
          <FormProblem>
            {problem === null ? null : t(`authentication.signIn.problems.${problem}`)}
          </FormProblem>
          <Button type="submit" variant="default" disabled={pending}>
            {pending ? t("authentication.signIn.pending") : t("authentication.signIn.submit")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setResetting(true)}>
            {t("authentication.signIn.forgotPassword")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
