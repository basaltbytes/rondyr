import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useActionState, useState } from "react";
import { useTranslation } from "react-i18next";

import { recoveryTokenLength } from "@rondyr/organizations/setup";

import { FormProblem, TextField } from "~/components/text-field";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { statusOf } from "~/lib/api/request";
import {
  authStatusQuery,
  emailOtpErrorOf,
  recoverWithPasskey,
  requestEmailOtp,
  signInWithPasskey,
  verifyEmailOtp,
} from "~/lib/api/session";
import { useLanguage } from "~/lib/i18n";
import { isWebAuthnClientError } from "~/lib/webauthn";

type PasskeyProblem =
  | "rateLimited"
  | "unavailable"
  | "refused"
  | "cancelled"
  | "unsupported"
  | "failed";

type OtpProblem = "rateLimited" | "noProvider" | "invalid" | "failed";

type RecoveryProblem =
  | "rateLimited"
  | "refused"
  | "rejected"
  | "cancelled"
  | "unsupported"
  | "failed";

function passkeyProblemOf(cause: unknown): PasskeyProblem {
  if (isWebAuthnClientError(cause)) {
    if (cause.problem === "cancelled") return "cancelled";
    if (cause.problem === "unsupported") return "unsupported";
    return "failed";
  }
  const status = statusOf(cause);
  if (status === 429) return "rateLimited";
  if (status !== null && status >= 500) return "unavailable";
  if (status === 401 || status === 400) return "refused";
  return "failed";
}

function otpProblemOf(cause: unknown): OtpProblem {
  if (emailOtpErrorOf(cause) === "email-provider-missing") return "noProvider";
  if (emailOtpErrorOf(cause) === "otp-invalid") return "invalid";
  const status = statusOf(cause);
  if (status === 429) return "rateLimited";
  if (status === 401 || status === 400) return "invalid";
  return "failed";
}

function recoveryProblemOf(cause: unknown): RecoveryProblem {
  if (isWebAuthnClientError(cause)) {
    if (cause.problem === "cancelled") return "cancelled";
    if (cause.problem === "unsupported") return "unsupported";
    return "failed";
  }
  const status = statusOf(cause);
  if (status === 429) return "rateLimited";
  if (status === 404) return "refused";
  if (status === 400 || status === 409) return "rejected";
  return "failed";
}

interface SignInFormProps {
  /** Opens what the account came for, once the session has started. */
  readonly onSignedIn: () => Promise<void>;
}

function EmailOtpForm({
  onSignedIn,
  onBack,
}: {
  readonly onSignedIn: () => Promise<void>;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const language = useLanguage();
  const [sentEmail, setSentEmail] = useState<string | null>(null);

  const [requestProblem, sendCode, sending] = useActionState(
    async (_previous: OtpProblem | null, data: FormData): Promise<OtpProblem | null> => {
      const email = data.get("email")?.toString().trim() ?? "";
      try {
        await requestEmailOtp(email, language);
        setSentEmail(email);
        return null;
      } catch (cause) {
        return otpProblemOf(cause);
      }
    },
    null,
  );

  const [verifyProblem, verifyCode, verifying] = useActionState(
    async (_previous: OtpProblem | null, data: FormData): Promise<OtpProblem | null> => {
      const code = data.get("code")?.toString().trim() ?? "";
      if (sentEmail === null) return "failed";
      try {
        await verifyEmailOtp(sentEmail, code);
        await onSignedIn();
        return null;
      } catch (cause) {
        return otpProblemOf(cause);
      }
    },
    null,
  );

  if (sentEmail !== null) {
    return (
      <form action={verifyCode} className="grid gap-4">
        <p className="text-sm text-pretty text-muted-foreground">
          {t("authentication.otp.sent", { email: sentEmail })}
        </p>
        <TextField
          label={t("authentication.otp.code")}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
        />
        <FormProblem>
          {verifyProblem === null ? null : t(`authentication.otp.problems.${verifyProblem}`)}
        </FormProblem>
        <Button type="submit" variant="default" disabled={verifying}>
          {verifying ? t("authentication.otp.verifying") : t("authentication.otp.verify")}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setSentEmail(null)}>
          {t("authentication.otp.changeEmail")}
        </Button>
      </form>
    );
  }

  return (
    <form action={sendCode} className="grid gap-4">
      <TextField
        label={t("authentication.signIn.email")}
        type="email"
        name="email"
        autoComplete="username"
        required
      />
      <FormProblem>
        {requestProblem === null ? null : t(`authentication.otp.problems.${requestProblem}`)}
      </FormProblem>
      <Button type="submit" variant="default" disabled={sending}>
        {sending ? t("authentication.otp.sending") : t("authentication.otp.send")}
      </Button>
      <Button type="button" variant="ghost" onClick={onBack}>
        {t("authentication.otp.back")}
      </Button>
    </form>
  );
}

function RecoveryForm({
  onSignedIn,
  onBack,
}: {
  readonly onSignedIn: () => Promise<void>;
  readonly onBack: () => void;
}) {
  const { t } = useTranslation();
  const [problem, recover, pending] = useActionState(
    async (_previous: RecoveryProblem | null, data: FormData): Promise<RecoveryProblem | null> => {
      const token = data.get("token")?.toString() ?? "";
      const email = data.get("email")?.toString().trim() ?? "";
      try {
        await recoverWithPasskey(token, email);
        await onSignedIn();
        return null;
      } catch (cause) {
        return recoveryProblemOf(cause);
      }
    },
    null,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("authentication.recovery.title")}</CardTitle>
        <CardDescription>{t("authentication.recovery.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={recover} className="grid gap-4">
          <TextField
            label={t("authentication.recovery.token")}
            hint={t("authentication.recovery.tokenHint", { minimum: recoveryTokenLength.minimum })}
            type="password"
            name="token"
            autoComplete="off"
            minLength={recoveryTokenLength.minimum}
            required
          />
          <TextField
            label={t("authentication.signIn.email")}
            type="email"
            name="email"
            autoComplete="username"
            required
          />
          <p className="text-xs text-pretty text-muted-foreground">
            {t("authentication.recovery.deleteReminder")}
          </p>
          <FormProblem>
            {problem === null ? null : t(`authentication.recovery.problems.${problem}`)}
          </FormProblem>
          <Button type="submit" variant="default" disabled={pending}>
            {pending ? t("authentication.recovery.pending") : t("authentication.recovery.submit")}
          </Button>
          <Button type="button" variant="ghost" onClick={onBack}>
            {t("authentication.recovery.back")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function SignInForm({ onSignedIn }: SignInFormProps) {
  const { t } = useTranslation();
  const status = useQuery(authStatusQuery);
  const emailOtpEnabled = status.data?.emailOtpEnabled === true;
  const recoveryEnabled = status.data?.recoveryEnabled === true;
  const [mode, setMode] = useState<"passkey" | "otp" | "recovery">("passkey");

  const [problem, signIn, pending] = useActionState(
    async (_previous: PasskeyProblem | null): Promise<PasskeyProblem | null> => {
      try {
        await signInWithPasskey();
        await onSignedIn();
        return null;
      } catch (cause) {
        return passkeyProblemOf(cause);
      }
    },
    null,
  );

  if (mode === "recovery" && recoveryEnabled) {
    return <RecoveryForm onSignedIn={onSignedIn} onBack={() => setMode("passkey")} />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("authentication.signIn.title")}</CardTitle>
        <CardDescription>{t("authentication.signIn.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {mode === "otp" && emailOtpEnabled ? (
          <EmailOtpForm onSignedIn={onSignedIn} onBack={() => setMode("passkey")} />
        ) : (
          <div className="grid gap-3">
            <form action={signIn} className="grid gap-3">
              <FormProblem>
                {problem === null ? null : t(`authentication.signIn.problems.${problem}`)}
              </FormProblem>
              <Button type="submit" variant="default" disabled={pending}>
                <KeyRound aria-hidden="true" className="size-4" />
                {pending ? t("authentication.signIn.pending") : t("authentication.signIn.submit")}
              </Button>
            </form>
            {emailOtpEnabled && (
              <Button type="button" variant="outline" onClick={() => setMode("otp")}>
                {t("authentication.otp.toggle")}
              </Button>
            )}
            {recoveryEnabled && (
              <Button type="button" variant="ghost" onClick={() => setMode("recovery")}>
                {t("authentication.recovery.toggle")}
              </Button>
            )}
            {status.data !== undefined && !emailOtpEnabled && !recoveryEnabled && (
              <p className="text-xs text-pretty text-muted-foreground">
                {t("authentication.signIn.noPasskeyHint")}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
