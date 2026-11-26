import { useQuery } from "@tanstack/react-query";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { setupTokenLength } from "@rondyr/organizations/setup";

import { CardFormSkeleton } from "~/components/page-pending";
import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { statusOf } from "~/lib/api/request";
import { authStatusQuery } from "~/lib/api/session";
import { createOwnerWithPasskey } from "~/lib/api/setup";
import { isWebAuthnClientError } from "~/lib/webauthn";

import { SignInForm } from "./sign-in-form.tsx";

type SetupProblem = "rejected" | "refused" | "rateLimited" | "cancelled" | "unsupported" | "failed";

function problemOf(cause: unknown): SetupProblem {
  if (isWebAuthnClientError(cause)) {
    if (cause.problem === "cancelled") return "cancelled";
    if (cause.problem === "unsupported") return "unsupported";
    return "failed";
  }
  const status = statusOf(cause);
  if (status === 400) return "rejected";
  if (status === 404) return "refused";
  if (status === 429) return "rateLimited";
  return "failed";
}

type Outcome = SetupProblem | "created";

/** Create the owner account with its first passkey and start a session atomically. */
async function claim(_previous: Outcome | null, data: FormData): Promise<Outcome> {
  const token = data.get("token")?.toString() ?? "";
  const name = data.get("name")?.toString().trim() ?? "";
  const email = data.get("email")?.toString().trim() ?? "";
  try {
    await createOwnerWithPasskey(token, { name, email });
    return "created";
  } catch (cause) {
    return problemOf(cause);
  }
}

interface SignedInProps {
  /** Opens the dashboard, once the session has started. */
  readonly onSignedIn: () => Promise<void>;
}

/** The form that creates the owner account and its passkey with the deployment setup token. */
function OwnerForm({ onSignedIn }: SignedInProps) {
  const { t } = useTranslation();
  const [outcome, create, pending] = useActionState(
    async (previous: Outcome | null, data: FormData) => {
      const next = await claim(previous, data);
      if (next === "created") await onSignedIn();
      return next;
    },
    null,
  );

  return (
    <form action={create} className="grid gap-4">
      <TextField
        label={t("setup.token")}
        hint={t("setup.tokenHint", { minimum: setupTokenLength.minimum })}
        type="password"
        name="token"
        autoComplete="off"
        minLength={setupTokenLength.minimum}
        required
      />
      <TextField label={t("setup.name")} name="name" autoComplete="name" maxLength={100} required />
      <TextField
        label={t("setup.email")}
        type="email"
        name="email"
        autoComplete="username"
        required
      />
      <FormProblem>
        {outcome === null || outcome === "created" ? null : t(`setup.problems.${outcome}`)}
      </FormProblem>
      <Button type="submit" variant="default" disabled={pending}>
        {pending ? t("setup.creating") : t("setup.submit")}
      </Button>
    </form>
  );
}

/**
 * What a signed-out visitor sees. A new instance asks for its owner account, which only
 * the person who knows the setup token of the deployment can create; any other instance
 * shows the sign-in form.
 */
export function SignedOut({ onSignedIn }: SignedInProps) {
  const { t } = useTranslation();
  const status = useQuery(authStatusQuery);
  const loaded = status.isError ? "failed" : (status.data?.setupState ?? null);

  if (loaded === null) {
    return (
      <Card>
        <CardContent>
          <CardFormSkeleton label={t("session.checking")} />
        </CardContent>
      </Card>
    );
  }
  // When the status cannot be read, the sign-in form still works for an existing account.
  if (loaded === "closed" || loaded === "failed") return <SignInForm onSignedIn={onSignedIn} />;
  if (loaded === "token-missing" || loaded === "token-too-short") {
    const minimum = setupTokenLength.minimum;
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("setup.title")}</CardTitle>
          <CardDescription>
            {loaded === "token-missing"
              ? t("setup.tokenMissing")
              : t("setup.tokenTooShort", { minimum })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-pretty text-muted-foreground">
            {t("setup.addToken", { minimum })}
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("setup.title")}</CardTitle>
        <CardDescription>{t("setup.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <OwnerForm onSignedIn={onSignedIn} />
      </CardContent>
    </Card>
  );
}
