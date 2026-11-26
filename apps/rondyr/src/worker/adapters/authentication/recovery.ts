import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { PasskeyId } from "../../../domain/organizations/account.ts";
import type { PasskeyRegistrationCredential } from "../../../domain/organizations/authentication.ts";
import { recoveryTokenLength } from "../../../domain/organizations/setup.ts";
import { UserId } from "../../../domain/submissions/submission.id.ts";
import {
  AuthUnavailable,
  PasskeyExists,
  RecoveryClosed,
  SetupRateLimited,
  type AuthenticatedSession,
} from "../../ports/authentication.ts";
import {
  consumeChallenge,
  creationOptions,
  storeChallenge,
  unnamedPasskey,
  userExcludedCredentials,
} from "./challenges.ts";
import {
  admitTokenAttempt,
  bindings,
  decodeExistsRow,
  decodeUserRow,
  equalSecrets,
  readConfig,
} from "./config.ts";
import { prepareSession } from "./sessions.ts";
import { parseRegistrationClientData, verifyRegistrationAttestation } from "./webauthn.ts";

const RecoveryChallengePayload = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
});

const decodeRecoveryPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecoveryChallengePayload),
);

const verifyRecoveryToken = Effect.fnUntraced(function* (request: Request) {
  const config = yield* readConfig(request);
  if (
    Option.isNone(config.recoveryToken) ||
    Redacted.value(config.recoveryToken.value).length < recoveryTokenLength.minimum
  ) {
    return yield* RecoveryClosed.make();
  }
  const header = request.headers.get("authorization");
  if (header === null) return yield* RecoveryClosed.make();
  if (!(yield* admitTokenAttempt("recovery", request))) return yield* SetupRateLimited.make();
  const matches = yield* equalSecrets(
    header,
    `Bearer ${Redacted.value(config.recoveryToken.value)}`,
  );
  if (!matches) return yield* RecoveryClosed.make();
  return config;
});

export const recoveryOptions = Effect.fn("Authentication.recoveryOptions")(function* (
  request: Request,
  rawEmail: string,
) {
  // Validate RONDYR_RECOVERY_TOKEN before reading auth_users so unknown addresses cannot be enumerated.
  const config = yield* verifyRecoveryToken(request);
  const env = yield* bindings;
  const email = rawEmail.toLowerCase();
  const row = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare("SELECT id, name, email FROM auth_users WHERE lower(email) = ? LIMIT 1")
        .bind(email)
        .first(),
    catch: () => AuthUnavailable.make(),
  });
  if (row === null) return yield* RecoveryClosed.make();
  const user = yield* decodeUserRow(row).pipe(Effect.mapError(() => AuthUnavailable.make()));
  const excludeCredentials = yield* userExcludedCredentials(env.DB, user.id);
  const challenge = yield* storeChallenge(env.DB, "recovery", {
    userId: user.id,
    name: user.name,
    email: user.email,
  });
  return creationOptions({
    challenge,
    rpId: config.rpId,
    userId: user.id,
    email: user.email,
    name: user.name,
    excludeCredentials,
  });
});

export const recoveryVerify = Effect.fn("Authentication.recoveryVerify")(function* (
  request: Request,
  credential: PasskeyRegistrationCredential,
  passkeyName?: string,
) {
  const config = yield* verifyRecoveryToken(request);
  const env = yield* bindings;
  const challengeBytes = yield* parseRegistrationClientData(credential, config.origin);
  const payloadJson = yield* consumeChallenge(env.DB, "recovery", challengeBytes);
  const payload = yield* decodeRecoveryPayload(payloadJson).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  const verified = yield* verifyRegistrationAttestation(credential, config.rpId);
  const now = yield* Clock.currentTimeMillis;
  const passkeyId = PasskeyId.make(SecureRandom.uuidV4Unsafe());
  const { session, setCookie } = yield* prepareSession(config, request, now);
  const label = passkeyName ?? unnamedPasskey;

  const [inserted, , , userCheck] = yield* Effect.tryPromise({
    try: () =>
      env.DB.batch([
        env.DB.prepare(`
          INSERT OR IGNORE INTO auth_passkeys
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
        // Whoever recovers the account takes it back: every earlier session ends.
        env.DB.prepare(`
          DELETE FROM auth_sessions
          WHERE user_id = ?1 AND EXISTS (SELECT 1 FROM auth_passkeys WHERE id = ?2)
        `).bind(payload.userId, passkeyId),
        env.DB.prepare(`
          INSERT INTO auth_sessions
            (id, token, user_id, expires_at, created_at, updated_at, ip_address, user_agent)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM auth_passkeys WHERE id = ?)
        `).bind(
          session.id,
          session.tokenHash,
          payload.userId,
          session.expiresAt,
          now,
          now,
          session.ipAddress,
          session.userAgent,
          passkeyId,
        ),
        env.DB.prepare("SELECT EXISTS (SELECT 1 FROM auth_users WHERE id = ?) AS stillExists").bind(
          payload.userId,
        ),
      ]),
    catch: () => AuthUnavailable.make(),
  });
  if (inserted?.meta.changes !== 1) {
    const state = yield* decodeExistsRow(userCheck?.results[0]).pipe(
      Effect.mapError(() => AuthUnavailable.make()),
    );
    if (state.stillExists === 0) return yield* RecoveryClosed.make();
    return yield* PasskeyExists.make();
  }
  return {
    session: { user: { id: payload.userId, name: payload.name, email: payload.email } },
    setCookie,
  } satisfies AuthenticatedSession;
});
