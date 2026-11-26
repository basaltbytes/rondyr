import { Clock, Effect, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { PasskeyId } from "../../../domain/organizations/account.ts";
import {
  challengeLifetimeMillis,
  type PasskeyAssertionCredential,
  type PasskeyRegistrationCredential,
  type PasskeyRequestOptions,
} from "../../../domain/organizations/authentication.ts";
import { UserId } from "../../../domain/submissions/submission.id.ts";
import {
  AuthUnavailable,
  LastPasskey,
  PasskeyExists,
  PasskeyInvalid,
  PasskeyNotFound,
  type AuthenticatedSession,
  type PreparedPasskeyRow,
  type VerifiedInvitationRegistration,
} from "../../ports/authentication.ts";
import {
  consumeChallenge,
  creationOptions,
  decodeStoredPasskey,
  decodeStoredPasskeys,
  storeChallenge,
  toPasskeySummary,
  unnamedPasskey,
  userExcludedCredentials,
} from "./challenges.ts";
import {
  bindings,
  decodeExistsRow,
  decodeUserRow,
  equalSecrets,
  readConfig,
  sha256Hex,
} from "./config.ts";
import { hmacSessionToken, prepareSession, readCookie, sessionCookieName } from "./sessions.ts";
import {
  parseAssertionClientData,
  parseRegistrationClientData,
  verifyAssertionSignature,
  verifyRegistrationAttestation,
} from "./webauthn.ts";

const PasskeyAuthRow = Schema.Struct({
  id: PasskeyId,
  userId: UserId,
  publicKey: Schema.String,
  algorithm: Schema.Int,
  counter: Schema.Int,
  rpId: Schema.String,
  name: Schema.String,
  email: Schema.String,
});

const InvitationChallengePayload = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
  tokenHash: Schema.String,
});

const AddPasskeyChallengePayload = Schema.Struct({
  userId: UserId,
});

const decodePasskeyAuthRow = Schema.decodeUnknownEffect(PasskeyAuthRow);
const decodeInvitationPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(InvitationChallengePayload),
);
const decodeAddPasskeyPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AddPasskeyChallengePayload),
);

export const passkeySignInOptions = Effect.fn("Authentication.passkeySignInOptions")(function* (
  request: Request,
) {
  const config = yield* readConfig(request);
  const env = yield* bindings;
  const challenge = yield* storeChallenge(env.DB, "sign-in", {});
  return {
    challenge,
    rpId: config.rpId,
    timeout: challengeLifetimeMillis,
    userVerification: "required",
    allowCredentials: [],
  } satisfies PasskeyRequestOptions;
});

export const passkeySignInVerify = Effect.fn("Authentication.passkeySignInVerify")(function* (
  request: Request,
  credential: PasskeyAssertionCredential,
) {
  const config = yield* readConfig(request);
  const env = yield* bindings;
  const { challenge, clientDataBytes } = yield* parseAssertionClientData(credential, config.origin);
  yield* consumeChallenge(env.DB, "sign-in", challenge);
  const row = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare(`
        SELECT p.id, p.user_id AS userId, p.public_key AS publicKey, p.algorithm,
          p.counter, p.rp_id AS rpId, u.name, u.email
        FROM auth_passkeys p JOIN auth_users u ON u.id = p.user_id
        WHERE p.credential_id = ?
      `)
        .bind(credential.id)
        .first(),
    catch: () => AuthUnavailable.make(),
  });
  if (row === null) return yield* PasskeyInvalid.make();
  const passkey = yield* decodePasskeyAuthRow(row).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  if (passkey.rpId !== config.rpId) return yield* PasskeyInvalid.make();
  const nextCounter = yield* verifyAssertionSignature({
    credential,
    clientDataBytes,
    expectedRpId: config.rpId,
    publicKey: passkey.publicKey,
    algorithm: passkey.algorithm,
    storedCounter: passkey.counter,
  });
  const now = yield* Clock.currentTimeMillis;
  const updated = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare(`
        UPDATE auth_passkeys SET counter = ?, last_used_at = ?
        WHERE id = ? AND counter = ? AND ((counter = 0 AND ? = 0) OR ? > counter)
        RETURNING id
      `)
        .bind(nextCounter, now, passkey.id, passkey.counter, nextCounter, nextCounter)
        .all(),
    catch: () => AuthUnavailable.make(),
  });
  if (updated.results.length !== 1) return yield* PasskeyInvalid.make();
  const { session, setCookie } = yield* prepareSession(config, request, now);
  yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare(`
        INSERT INTO auth_sessions
          (id, token, user_id, expires_at, created_at, updated_at, ip_address, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(
          session.id,
          session.tokenHash,
          passkey.userId,
          session.expiresAt,
          now,
          now,
          session.ipAddress,
          session.userAgent,
        )
        .run(),
    catch: () => AuthUnavailable.make(),
  });
  return {
    session: { user: { id: passkey.userId, name: passkey.name, email: passkey.email } },
    setCookie,
  } satisfies AuthenticatedSession;
});

export const invitationOptions = Effect.fn("Authentication.invitationOptions")(function* (
  request: Request,
  input: {
    readonly token: Redacted.Redacted<string>;
    readonly name: string;
    readonly email: string;
  },
) {
  const config = yield* readConfig(request);
  const env = yield* bindings;
  const userIdValue = UserId.make(SecureRandom.uuidV4Unsafe());
  const tokenHash = yield* sha256Hex(Redacted.value(input.token));
  const email = input.email.toLowerCase();
  const challenge = yield* storeChallenge(env.DB, "invitation", {
    userId: userIdValue,
    name: input.name,
    email,
    tokenHash,
  });
  return creationOptions({
    challenge,
    rpId: config.rpId,
    userId: userIdValue,
    email,
    name: input.name,
  });
});

export const invitationVerify = Effect.fn("Authentication.invitationVerify")(function* (
  request: Request,
  token: Redacted.Redacted<string>,
  credential: PasskeyRegistrationCredential,
  passkeyName?: string,
) {
  const config = yield* readConfig(request);
  const env = yield* bindings;
  const challengeBytes = yield* parseRegistrationClientData(credential, config.origin);
  const payloadJson = yield* consumeChallenge(env.DB, "invitation", challengeBytes);
  const payload = yield* decodeInvitationPayload(payloadJson).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  const tokenHash = yield* sha256Hex(Redacted.value(token));
  if (!(yield* equalSecrets(tokenHash, payload.tokenHash))) {
    return yield* PasskeyInvalid.make();
  }
  const verified = yield* verifyRegistrationAttestation(credential, config.rpId);
  const existingCredential = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare("SELECT 1 FROM auth_passkeys WHERE credential_id = ? LIMIT 1")
        .bind(verified.credentialId)
        .first(),
    catch: () => AuthUnavailable.make(),
  });
  if (existingCredential !== null) return yield* PasskeyInvalid.make();

  const now = yield* Clock.currentTimeMillis;
  const { session, setCookie } = yield* prepareSession(config, request, now);
  const passkey: PreparedPasskeyRow = {
    id: PasskeyId.make(SecureRandom.uuidV4Unsafe()),
    name: passkeyName ?? unnamedPasskey,
    credentialId: verified.credentialId,
    publicKey: verified.publicKey,
    algorithm: verified.algorithm,
    counter: verified.counter,
    transports: verified.transports,
    rpId: config.rpId,
  };
  return {
    userId: payload.userId,
    name: payload.name,
    email: payload.email,
    passkey,
    session,
    setCookie,
  } satisfies VerifiedInvitationRegistration;
});

export const listPasskeys = Effect.fn("Authentication.listPasskeys")(function* (
  request: Request,
  userIdValue: typeof UserId.Type,
) {
  const config = yield* readConfig(request);
  const env = yield* bindings;
  const rows = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare(`
        SELECT id, name, rp_id AS rpId, created_at AS createdAt, last_used_at AS lastUsedAt
        FROM auth_passkeys
        WHERE user_id = ?
        ORDER BY created_at DESC, id
      `)
        .bind(userIdValue)
        .all(),
    catch: () => AuthUnavailable.make(),
  });
  const decoded = yield* decodeStoredPasskeys(rows.results).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  return decoded.map((row) => toPasskeySummary(row, config.rpId));
});

export const addPasskeyOptions = Effect.fn("Authentication.addPasskeyOptions")(function* (
  request: Request,
  userIdValue: typeof UserId.Type,
) {
  const config = yield* readConfig(request);
  const env = yield* bindings;
  const row = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare("SELECT id, name, email FROM auth_users WHERE id = ? LIMIT 1")
        .bind(userIdValue)
        .first(),
    catch: () => AuthUnavailable.make(),
  });
  if (row === null) return yield* AuthUnavailable.make();
  const user = yield* decodeUserRow(row).pipe(Effect.mapError(() => AuthUnavailable.make()));
  const excludeCredentials = yield* userExcludedCredentials(env.DB, user.id);
  const challenge = yield* storeChallenge(env.DB, "add-passkey", { userId: user.id });
  return creationOptions({
    challenge,
    rpId: config.rpId,
    userId: user.id,
    email: user.email,
    name: user.name,
    excludeCredentials,
  });
});

export const addPasskeyVerify = Effect.fn("Authentication.addPasskeyVerify")(function* (
  request: Request,
  userIdValue: typeof UserId.Type,
  credential: PasskeyRegistrationCredential,
  name?: string,
) {
  const config = yield* readConfig(request);
  const env = yield* bindings;
  const challengeBytes = yield* parseRegistrationClientData(credential, config.origin);
  const payloadJson = yield* consumeChallenge(env.DB, "add-passkey", challengeBytes);
  const payload = yield* decodeAddPasskeyPayload(payloadJson).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  if (payload.userId !== userIdValue) return yield* PasskeyInvalid.make();
  const verified = yield* verifyRegistrationAttestation(credential, config.rpId);
  const now = yield* Clock.currentTimeMillis;
  const passkeyId = PasskeyId.make(SecureRandom.uuidV4Unsafe());
  const label = name ?? unnamedPasskey;
  const inserted = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare(`
        INSERT OR IGNORE INTO auth_passkeys
          (id, user_id, name, credential_id, public_key, algorithm, counter, transports, rp_id, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        RETURNING id, name, rp_id AS rpId, created_at AS createdAt, last_used_at AS lastUsedAt
      `)
        .bind(
          passkeyId,
          userIdValue,
          label,
          verified.credentialId,
          verified.publicKey,
          verified.algorithm,
          verified.counter,
          verified.transports,
          config.rpId,
          now,
        )
        .all(),
    catch: () => AuthUnavailable.make(),
  });
  const created = inserted.results[0];
  if (created === undefined) return yield* PasskeyExists.make();
  const decoded = yield* decodeStoredPasskey(created).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  return toPasskeySummary(decoded, config.rpId);
});

export const renamePasskey = Effect.fn("Authentication.renamePasskey")(function* (
  request: Request,
  userIdValue: typeof UserId.Type,
  passkeyId: PasskeyId,
  name: string,
) {
  const config = yield* readConfig(request);
  const env = yield* bindings;
  const updated = yield* Effect.tryPromise({
    try: () =>
      env.DB.prepare(`
        UPDATE auth_passkeys SET name = ?
        WHERE id = ? AND user_id = ?
        RETURNING id, name, rp_id AS rpId, created_at AS createdAt, last_used_at AS lastUsedAt
      `)
        .bind(name, passkeyId, userIdValue)
        .first(),
    catch: () => AuthUnavailable.make(),
  });
  if (updated === null) return yield* PasskeyNotFound.make();
  const decoded = yield* decodeStoredPasskey(updated).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  return toPasskeySummary(decoded, config.rpId);
});

export const deletePasskey = Effect.fn("Authentication.deletePasskey")(function* (
  request: Request,
  userIdValue: typeof UserId.Type,
  passkeyId: PasskeyId,
  allowDeleteLast: boolean,
) {
  const config = yield* readConfig(request);
  const env = yield* bindings;
  const rawToken = readCookie(request, sessionCookieName(config.secure));
  const currentSession =
    rawToken === null ? "" : yield* hmacSessionToken(config.sessionSecret, rawToken);
  const allow = allowDeleteLast ? 1 : 0;
  // Only a passkey of the current domain can sign in here. Without email codes, the
  // last of those stays; a passkey of another domain can always go.
  const [, deleted, remaining] = yield* Effect.tryPromise({
    try: () =>
      env.DB.batch([
        // Removing a passkey ends the other sessions of the account, so a session opened
        // with that passkey does not outlive it. This runs first, under the condition of
        // the deletion below, while the passkey is still there to test.
        env.DB.prepare(`
          DELETE FROM auth_sessions
          WHERE user_id = ?2 AND token <> ?5
            AND EXISTS (
              SELECT 1 FROM auth_passkeys target
              WHERE target.id = ?1 AND target.user_id = ?2
                AND (?3 = 1 OR target.rp_id <> ?4 OR EXISTS (
                  SELECT 1 FROM auth_passkeys other
                  WHERE other.user_id = ?2 AND other.id <> ?1 AND other.rp_id = ?4
                ))
            )
        `).bind(passkeyId, userIdValue, allow, config.rpId, currentSession),
        env.DB.prepare(`
          DELETE FROM auth_passkeys
          WHERE id = ?1 AND user_id = ?2
            AND (?3 = 1 OR rp_id <> ?4 OR EXISTS (
              SELECT 1 FROM auth_passkeys other
              WHERE other.user_id = ?2 AND other.id <> ?1 AND other.rp_id = ?4
            ))
          RETURNING id
        `).bind(passkeyId, userIdValue, allow, config.rpId),
        env.DB.prepare(
          "SELECT EXISTS (SELECT 1 FROM auth_passkeys WHERE id = ?1 AND user_id = ?2) AS stillExists",
        ).bind(passkeyId, userIdValue),
      ]),
    catch: () => AuthUnavailable.make(),
  });
  if ((deleted?.results.length ?? 0) > 0) return;
  const state = yield* decodeExistsRow(remaining?.results[0]).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  if (state.stillExists === 1) return yield* LastPasskey.make();
  return yield* PasskeyNotFound.make();
});
