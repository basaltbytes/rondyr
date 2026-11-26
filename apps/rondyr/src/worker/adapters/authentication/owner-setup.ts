import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { PasskeyId } from "../../../domain/organizations/account.ts";
import type { PasskeyRegistrationCredential } from "../../../domain/organizations/authentication.ts";
import { setupTokenLength } from "../../../domain/organizations/setup.ts";
import { UserId } from "../../../domain/submissions/submission.id.ts";
import {
  AuthUnavailable,
  SetupClosed,
  SetupRateLimited,
  type AuthenticatedSession,
} from "../../ports/authentication.ts";
import { consumeChallenge, creationOptions, storeChallenge, unnamedPasskey } from "./challenges.ts";
import { accountExists, admitTokenAttempt, bindings, equalSecrets, readConfig } from "./config.ts";
import { prepareSession } from "./sessions.ts";
import { parseRegistrationClientData, verifyRegistrationAttestation } from "./webauthn.ts";

const SetupChallengePayload = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
});

const decodeSetupPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(SetupChallengePayload));

const verifySetupToken = Effect.fnUntraced(function* (request: Request) {
  const config = yield* readConfig(request);
  if (
    Option.isNone(config.setupToken) ||
    Redacted.value(config.setupToken.value).length < setupTokenLength.minimum
  ) {
    return yield* SetupClosed.make();
  }
  const header = request.headers.get("authorization");
  if (header === null) return yield* SetupClosed.make();
  if (!(yield* admitTokenAttempt("setup", request))) return yield* SetupRateLimited.make();
  const matches = yield* equalSecrets(header, `Bearer ${Redacted.value(config.setupToken.value)}`);
  if (!matches) return yield* SetupClosed.make();
  return config;
});

export const setupOptions = Effect.fn("Authentication.setupOptions")(function* (
  request: Request,
  input: { readonly name: string; readonly email: string },
) {
  const config = yield* verifySetupToken(request);
  const env = yield* bindings;
  if (yield* accountExists(env.DB)) return yield* SetupClosed.make();
  const userIdValue = UserId.make(SecureRandom.uuidV4Unsafe());
  const email = input.email.toLowerCase();
  const challenge = yield* storeChallenge(env.DB, "setup", {
    userId: userIdValue,
    name: input.name,
    email,
  });
  return creationOptions({
    challenge,
    rpId: config.rpId,
    userId: userIdValue,
    email,
    name: input.name,
  });
});

export const setupVerify = Effect.fn("Authentication.setupVerify")(function* (
  request: Request,
  credential: PasskeyRegistrationCredential,
  passkeyName?: string,
) {
  const config = yield* verifySetupToken(request);
  const env = yield* bindings;
  if (yield* accountExists(env.DB)) return yield* SetupClosed.make();
  const challengeBytes = yield* parseRegistrationClientData(credential, config.origin);
  const payloadJson = yield* consumeChallenge(env.DB, "setup", challengeBytes);
  const payload = yield* decodeSetupPayload(payloadJson).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  const verified = yield* verifyRegistrationAttestation(credential, config.rpId);
  const now = yield* Clock.currentTimeMillis;
  const passkeyId = PasskeyId.make(SecureRandom.uuidV4Unsafe());
  const { session, setCookie } = yield* prepareSession(config, request, now);
  const label = passkeyName ?? unnamedPasskey;

  // D1 executes the batch atomically. A racing request can only insert the passkey and
  // session when its own user ID won the `WHERE NOT EXISTS (SELECT 1 FROM auth_users)` guard.
  const [inserted] = yield* Effect.tryPromise({
    try: () =>
      env.DB.batch([
        env.DB.prepare(`
          INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at)
          SELECT ?, ?, ?, 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM auth_users)
        `).bind(payload.userId, payload.name, payload.email, now, now),
        env.DB.prepare(`
          INSERT INTO auth_passkeys
            (id, user_id, name, credential_id, public_key, algorithm, counter, transports, rp_id, created_at, last_used_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
          WHERE EXISTS (SELECT 1 FROM auth_users WHERE id = ?)
        `).bind(
          passkeyId,
          payload.userId,
          label,
          verified.credentialId,
          verified.publicKey,
          verified.algorithm,
          verified.counter,
          verified.transports,
          config.rpId,
          now,
          payload.userId,
        ),
        env.DB.prepare(`
          INSERT INTO auth_sessions
            (id, token, user_id, expires_at, created_at, updated_at, ip_address, user_agent)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM auth_users WHERE id = ?)
        `).bind(
          session.id,
          session.tokenHash,
          payload.userId,
          session.expiresAt,
          now,
          now,
          session.ipAddress,
          session.userAgent,
          payload.userId,
        ),
      ]),
    catch: () => AuthUnavailable.make(),
  });
  if (inserted?.meta.changes !== 1) return yield* SetupClosed.make();
  return {
    session: { user: { id: payload.userId, name: payload.name, email: payload.email } },
    setCookie,
  } satisfies AuthenticatedSession;
});
