import { Schema } from "effect";
import { useActionState, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { accountPasswordLength } from "@rondyr/organizations/account";
import type { InvitationSummary } from "@rondyr/organizations/members";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { authClient } from "~/lib/auth-client";
import { acceptInvitation, MemberRequestFailed, readInvitation } from "~/lib/members-client";

import { SignOutButton } from "./account.tsx";
import { SignInForm } from "./sign-in-form.tsx";

const isRequestFailure = Schema.is(MemberRequestFailed);

type Summary = typeof InvitationSummary.Type;
type Loaded = Summary | "invalid" | "failed";
type AcceptProblem = "invalid" | "otherAccount" | "signInRequired" | "failed";

function problemOf(error: MemberRequestFailed | null): AcceptProblem {
  if (error === null) return "failed";
  if (error.error === "invitation-invalid") return "invalid";
  if (error.error === "other-account") return "otherAccount";
  if (error.error === "sign-in-required") return "signInRequired";
  return "failed";
}

/** The dashboard opens with the organization that the account just joined. */
function openDashboard() {
  window.location.assign("/");
}

function NewAccountForm({ token, summary }: { token: string; summary: Summary }) {
  const { t } = useTranslation();
  const [problem, create, pending] = useActionState(
    async (_: AcceptProblem | "rejected" | null, data: FormData) => {
      const name = data.get("name")?.toString().trim() ?? "";
      const password = data.get("password")?.toString() ?? "";
      try {
        await acceptInvitation(token, { name, password });
      } catch (error) {
        if (isRequestFailure(error) && error.status === 400) return "rejected";
        return problemOf(isRequestFailure(error) ? error : null);
      }
      try {
        const result = await authClient.signIn.email({ email: summary.email, password });
        if (result.error !== null) return "failed";
      } catch {
        return "failed";
      }
      openDashboard();
      return null;
    },
    null,
  );

  return (
    <form action={create} className="grid gap-4">
      <TextField
        label={t("invitation.email")}
        value={summary.email}
        readOnly
        autoComplete="username"
      />
      <TextField
        label={t("invitation.name")}
        name="name"
        autoComplete="name"
        maxLength={100}
        required
      />
      <TextField
        label={t("invitation.password")}
        hint={t("invitation.passwordHint", { minimum: accountPasswordLength.minimum })}
        type="password"
        name="password"
        autoComplete="new-password"
        minLength={accountPasswordLength.minimum}
        maxLength={accountPasswordLength.maximum}
        required
      />
      <FormProblem>{problem === null ? null : t(`invitation.problems.${problem}`)}</FormProblem>
      <Button type="submit" variant="default" disabled={pending}>
        {pending ? t("invitation.joining") : t("invitation.createAndJoin")}
      </Button>
    </form>
  );
}

function JoinButton({ token }: { token: string }) {
  const { t } = useTranslation();
  const [problem, join, pending] = useActionState(async (): Promise<AcceptProblem | null> => {
    try {
      await acceptInvitation(token);
    } catch (error) {
      return problemOf(isRequestFailure(error) ? error : null);
    }
    openDashboard();
    return null;
  }, null);

  return (
    <form action={join} className="grid gap-3">
      <FormProblem>{problem === null ? null : t(`invitation.problems.${problem}`)}</FormProblem>
      <Button type="submit" variant="default" disabled={pending}>
        {pending ? t("invitation.joining") : t("invitation.join")}
      </Button>
    </form>
  );
}

function Acceptance({ token, summary }: { token: string; summary: Summary }) {
  const { t } = useTranslation();
  const session = authClient.useSession();
  if (session.isPending) {
    return <output className="text-sm text-muted-foreground">{t("session.checking")}</output>;
  }
  const signedIn = session.data?.user.email ?? null;
  if (signedIn !== null && signedIn.toLowerCase() !== summary.email) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-pretty">
          {t("invitation.otherAccount", { signedIn, invited: summary.email })}
        </p>
        <SignOutButton email={signedIn} />
      </div>
    );
  }
  if (signedIn !== null) return <JoinButton token={token} />;
  if (summary.account === "new") return <NewAccountForm token={token} summary={summary} />;
  return (
    <div className="grid gap-3">
      <p className="text-sm text-pretty text-muted-foreground">
        {t("invitation.signInFirst", { email: summary.email })}
      </p>
      <SignInForm />
    </div>
  );
}

interface InvitationAcceptanceProps {
  /** The secret of the link, from the fragment of its URL. */
  readonly token: string;
}

/** The page that an invitation link opens. Nobody needs to be signed in to see it. */
export function InvitationAcceptance({ token }: InvitationAcceptanceProps) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [requests, setRequests] = useState(0);

  // oxlint-disable-next-line rondyr/no-unreasoned-effect -- Loads the invitation of the link from the Rondyr API.
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const summary = await readInvitation(token);
        if (current) setLoaded(summary);
      } catch (error) {
        const invalid = isRequestFailure(error) && error.status === 404;
        if (current) setLoaded(invalid ? "invalid" : "failed");
      }
    }
    void load();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A retry initiates a new API request.
  }, [token, requests]);

  return (
    <Card>
      {loaded === null && (
        <CardContent>
          <output className="text-sm text-muted-foreground">{t("invitation.loading")}</output>
        </CardContent>
      )}
      {loaded === "invalid" && (
        <>
          <CardHeader>
            <CardTitle>{t("invitation.invalidTitle")}</CardTitle>
            <CardDescription>{t("invitation.invalid")}</CardDescription>
          </CardHeader>
          <CardContent>
            <a href="/" className="text-sm font-medium underline underline-offset-4">
              {t("invitation.openDashboard")}
            </a>
          </CardContent>
        </>
      )}
      {loaded === "failed" && (
        <CardContent>
          <div className="grid justify-items-start gap-2">
            <FormProblem>{t("invitation.loadFailed")}</FormProblem>
            <Button onClick={() => setRequests((value) => value + 1)}>
              {t("invitation.retry")}
            </Button>
          </div>
        </CardContent>
      )}
      {loaded !== null && loaded !== "invalid" && loaded !== "failed" && (
        <>
          <CardHeader>
            <CardTitle className="wrap-anywhere">
              {t("invitation.title", { organization: loaded.organizationName })}
            </CardTitle>
            <CardDescription className="wrap-anywhere">
              {t(`invitation.as.${loaded.role}`, { email: loaded.email })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Acceptance token={token} summary={loaded} />
          </CardContent>
        </>
      )}
    </Card>
  );
}
