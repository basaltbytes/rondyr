import { Effect, Layer, Option } from "effect";

import {
  recoveryEnabled,
  setupState as stateOf,
  type AuthStatus,
} from "../../../domain/organizations/setup.ts";
import { Authentication, AuthUnavailable } from "../../ports/authentication.ts";
import { EmailSender } from "../../ports/email-sender.ts";
import { accountExists, bindings, decodeEnv, nonEmpty, verifyOrigin } from "./config.ts";
import { issueEmailOtp, verifyEmailOtp } from "./email-otp.ts";
import { setupOptions, setupVerify } from "./owner-setup.ts";
import {
  addPasskeyOptions,
  addPasskeyVerify,
  deletePasskey,
  invitationOptions,
  invitationVerify,
  listPasskeys,
  passkeySignInOptions,
  passkeySignInVerify,
  renamePasskey,
} from "./passkeys.ts";
import { recoveryOptions, recoveryVerify } from "./recovery.ts";
import { getSession, purgeExpired, signOut } from "./sessions.ts";

export const authenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const emailSender = yield* EmailSender;

    const authStatus = Effect.gen(function* () {
      const env = yield* bindings;
      const parsed = yield* decodeEnv(env).pipe(Effect.mapError(() => AuthUnavailable.make()));
      const exists = yield* accountExists(env.DB);
      const setupRaw = Option.fromUndefinedOr(nonEmpty(parsed.RONDYR_SETUP_TOKEN));
      const recoveryRaw = Option.fromUndefinedOr(nonEmpty(parsed.RONDYR_RECOVERY_TOKEN));
      const emailOtpEnabled = yield* emailSender.sender.pipe(
        Effect.as(true),
        Effect.catchTag("EmailProviderMissing", () => Effect.succeed(false)),
      );
      return {
        setupState: stateOf(exists, setupRaw),
        emailOtpEnabled,
        recoveryEnabled: recoveryEnabled(recoveryRaw),
      } satisfies AuthStatus;
    }).pipe(Effect.withSpan("Authentication.authStatus"));

    return {
      verifyOrigin,
      getSession,
      signOut,
      authStatus,
      setupOptions,
      setupVerify,
      passkeySignInOptions,
      passkeySignInVerify,
      issueEmailOtp,
      verifyEmailOtp,
      recoveryOptions,
      recoveryVerify,
      invitationOptions,
      invitationVerify,
      listPasskeys,
      addPasskeyOptions,
      addPasskeyVerify,
      renamePasskey,
      deletePasskey,
      purgeExpired,
    };
  }),
);
