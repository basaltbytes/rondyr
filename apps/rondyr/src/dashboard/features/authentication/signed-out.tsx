import { Schema } from "effect";
import { useActionState, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { accountPasswordLength } from "@rondyr/organizations/account";
import { setupTokenLength, type SetupState } from "@rondyr/organizations/setup";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { authClient } from "~/lib/auth-client";
import { createOwner, readSetupState, SetupRequestFailed } from "~/lib/setup-client";

import { SignInForm } from "./sign-in-form.tsx";

const isRequestFailure = Schema.is(SetupRequestFailed);

type SetupProblem = "rejected" | "refused" | "rateLimited" | "failed";

function problemOf(error: SetupRequestFailed | null): SetupProblem {
  if (error === null) return "failed";
  if (error.status === 400) return "rejected";
  if (error.status === 404) return "refused";
  if (error.status === 429) return "rateLimited";
  return "failed";
}

type Outcome = SetupProblem | "created" | "signInFailed";

/** Create the owner account, then sign in with it. */
async function claim(_previous: Outcome | null, data: FormData): Promise<Outcome> {
  const token = data.get("token")?.toString() ?? "";
  const name = data.get("name")?.toString().trim() ?? "";
  const email = data.get("email")?.toString().trim() ?? "";
  const password = data.get("password")?.toString() ?? "";
  try {
    await createOwner(token, { name, email, password });
  } catch (error) {
    return problemOf(isRequestFailure(error) ? error : null);
  }
  // The session then shows the dashboard in place of this page.
  try {
    const result = await authClient.signIn.email({ email, password });
    if (result.error === null) return "created";
  } catch {
    return "signInFailed";
  }
  return "signInFailed";
}

/** The form that creates the owner account with the setup token of the deployment. */
function OwnerForm() {
  const { t } = useTranslation();
  const [outcome, create, pending] = useActionState(claim, null);

  if (outcome === "signInFailed") {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-pretty">{t("setup.created")}</p>
        <SignInForm />
      </div>
    );
  }
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
      <TextField
        label={t("setup.password")}
        hint={t("setup.passwordHint", {
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
        {outcome === null || outcome === "created" ? null : t(`setup.problems.${outcome}`)}
      </FormProblem>
      <Button type="submit" variant="default" disabled={pending}>
        {pending ? t("setup.creating") : t("setup.submit")}
      </Button>
    </form>
  );
}

type Loaded = SetupState | "failed";

/**
 * What a signed-out visitor sees. A new instance asks for its owner account, which only
 * the person who knows the setup token of the deployment can create; any other instance
 * shows the sign-in form.
 */
export function SignedOut() {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Reads the setup state from the Rondyr API.
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const state = await readSetupState();
        if (current) setLoaded(state);
      } catch {
        if (current) setLoaded("failed");
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, []);

  if (loaded === null) {
    return <output className="text-sm text-muted-foreground">{t("session.checking")}</output>;
  }
  // When the state cannot be read, the sign-in form still works for an existing account.
  if (loaded === "closed" || loaded === "failed") return <SignInForm />;
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
        <OwnerForm />
      </CardContent>
    </Card>
  );
}
