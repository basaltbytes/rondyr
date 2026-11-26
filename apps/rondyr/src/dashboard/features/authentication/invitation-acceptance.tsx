import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActionState } from "react";
import { useTranslation } from "react-i18next";

import { CardFormSkeleton } from "~/components/page-pending";
import { ReadFailure } from "~/components/read-failure";
import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  acceptInvitation,
  acceptInvitationWithPasskey,
  invitationQuery,
  type InvitationSummary,
} from "~/lib/api/invitations";
import { memberErrorOf } from "~/lib/api/members";
import { statusOf } from "~/lib/api/request";
import { sessionQuery } from "~/lib/api/session";
import { isWebAuthnClientError } from "~/lib/webauthn";

import { SignOutButton } from "./sign-out-button.tsx";
import { SignInForm } from "./sign-in-form.tsx";

type Summary = InvitationSummary;
type AcceptProblem =
  | "invalid"
  | "otherAccount"
  | "signInRequired"
  | "rejected"
  | "cancelled"
  | "unsupported"
  | "failed";

function problemOf(cause: unknown): AcceptProblem {
  if (isWebAuthnClientError(cause)) {
    if (cause.problem === "cancelled") return "cancelled";
    if (cause.problem === "unsupported") return "unsupported";
    return "failed";
  }
  const error = memberErrorOf(cause);
  if (error === "invitation-invalid") return "invalid";
  if (error === "other-account") return "otherAccount";
  if (error === "sign-in-required") return "signInRequired";
  if (statusOf(cause) === 400) return "rejected";
  return "failed";
}

/** The dashboard opens with the organization that the account just joined. */
function openDashboard() {
  window.location.assign("/");
}

function NewAccountForm({ token, summary }: { readonly token: string; readonly summary: Summary }) {
  const { t } = useTranslation();
  const [problem, create, pending] = useActionState(
    async (_: AcceptProblem | null, data: FormData): Promise<AcceptProblem | null> => {
      const name = data.get("name")?.toString().trim() ?? "";
      try {
        await acceptInvitationWithPasskey(token, name);
      } catch (cause) {
        return problemOf(cause);
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
      <FormProblem>{problem === null ? null : t(`invitation.problems.${problem}`)}</FormProblem>
      <Button type="submit" variant="default" disabled={pending}>
        {pending ? t("invitation.joining") : t("invitation.createAndJoin")}
      </Button>
    </form>
  );
}

function JoinButton({ token }: { readonly token: string }) {
  const { t } = useTranslation();
  const { mutateAsync: accept } = useMutation({
    mutationFn: () => acceptInvitation(token),
  });
  const [problem, join, pending] = useActionState(async (): Promise<AcceptProblem | null> => {
    try {
      await accept();
    } catch (cause) {
      return problemOf(cause);
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

function Acceptance({ token, summary }: { readonly token: string; readonly summary: Summary }) {
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
