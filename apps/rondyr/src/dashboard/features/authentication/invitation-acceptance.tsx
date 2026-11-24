import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { accountPasswordLength } from "@rondyr/organizations/account";

import { CardFormSkeleton } from "~/components/page-pending";
import { ReadFailure } from "~/components/read-failure";
import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { acceptInvitation, invitationQuery, type InvitationSummary } from "~/lib/api/invitations";
import { memberErrorOf } from "~/lib/api/members";
import { statusOf } from "~/lib/api/request";
import { authClient, sessionQuery } from "~/lib/api/session";

import { SignOutButton } from "./sign-out-button.tsx";
import { SignInForm } from "./sign-in-form.tsx";

type Summary = InvitationSummary;
type AcceptProblem = "invalid" | "otherAccount" | "signInRequired" | "failed";

function problemOf(error: string | null): AcceptProblem {
  if (error === "invitation-invalid") return "invalid";
  if (error === "other-account") return "otherAccount";
  if (error === "sign-in-required") return "signInRequired";
  return "failed";
}

/** Accepts the invitation of a link, as the signed-in account or with a new one. */
function useAccept(token: string) {
  return useMutation({
    mutationFn: (account?: { readonly name: string; readonly password: string }) =>
      acceptInvitation(token, account),
  });
}

/** The dashboard opens with the organization that the account just joined. */
function openDashboard() {
  window.location.assign("/");
}

function NewAccountForm({ token, summary }: { token: string; summary: Summary }) {
  const { t } = useTranslation();
  const { mutateAsync: accept } = useAccept(token);
  const [problem, create, pending] = useActionState(
    async (_: AcceptProblem | "rejected" | null, data: FormData) => {
      const name = data.get("name")?.toString().trim() ?? "";
      const password = data.get("password")?.toString() ?? "";
      try {
        await accept({ name, password });
      } catch (cause) {
        if (statusOf(cause) === 400) return "rejected";
        return problemOf(memberErrorOf(cause));
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
  const { mutateAsync: accept } = useAccept(token);
  const [problem, join, pending] = useActionState(async (): Promise<AcceptProblem | null> => {
    try {
      await accept();
    } catch (cause) {
      return problemOf(memberErrorOf(cause));
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
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery);
  // A sign-in or a sign-out on this page changes who accepts: the page reads it again.
  const signedInOrOut = () => queryClient.resetQueries();
  if (session.isPending) {
    return <CardFormSkeleton label={t("session.checking")} />;
  }
  const signedIn = session.data?.user.email ?? null;
  if (signedIn !== null && signedIn.toLowerCase() !== summary.email) {
    return (
      <div className="grid gap-3">
        <p className="text-sm text-pretty">
          {t("invitation.otherAccount", { signedIn, invited: summary.email })}
        </p>
        <SignOutButton email={signedIn} onSignedOut={signedInOrOut} />
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
      <SignInForm onSignedIn={signedInOrOut} />
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
  const invitation = useQuery(invitationQuery(token));
  // An unknown, used or expired link answers 404.
  const invalid = invitation.isError && statusOf(invitation.error) === 404;
  const loaded = invitation.data;

  return (
    <Card>
      {invitation.isPending && (
        <CardContent>
          <CardFormSkeleton label={t("invitation.loading")} />
        </CardContent>
      )}
      {invalid && (
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
      {invitation.isError && !invalid && (
        <CardContent>
          <ReadFailure
            cause={invitation.error}
            title={t("invitation.loadFailed")}
            retry={t("invitation.retry")}
            retrying={invitation.isFetching}
            onRetry={() => void invitation.refetch()}
          />
        </CardContent>
      )}
      {loaded !== undefined && (
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
