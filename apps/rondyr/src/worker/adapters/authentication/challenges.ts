import { Clock, Effect, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { Base64Url } from "effect/encoding";

import { PasskeyId } from "../../../domain/organizations/account.ts";
import {
  challengeLifetimeMillis,
  type PasskeyCreationOptions,
  type PasskeySummary,
} from "../../../domain/organizations/authentication.ts";
import type { UserId } from "../../../domain/submissions/submission.id.ts";
import { AuthUnavailable, PasskeyInvalid } from "../../ports/authentication.ts";
import { encoder, sha256BytesHex } from "./config.ts";
import { supportedPasskeyAlgorithms } from "./webauthn.ts";

/** A passkey registered without a name: the dashboard shows its own translated label. */
export const unnamedPasskey = "";

const ChallengeRow = Schema.Struct({
  payloadJson: Schema.String,
});

const CredentialIdRow = Schema.Struct({
  credentialId: Schema.String,
  transports: Schema.NullOr(Schema.String),
});

export const StoredPasskeyRow = Schema.Struct({
  id: PasskeyId,
  name: Schema.String,
  rpId: Schema.String,
  createdAt: Schema.Int,
  lastUsedAt: Schema.NullOr(Schema.Int),
});

const decodeChallengeRow = Schema.decodeUnknownEffect(ChallengeRow);
const decodeCredentialIds = Schema.decodeUnknownEffect(Schema.Array(CredentialIdRow));
const decodeTransports = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const decodeStoredPasskeys = Schema.decodeUnknownEffect(Schema.Array(StoredPasskeyRow));

export const decodeStoredPasskey = Schema.decodeUnknownEffect(StoredPasskeyRow);

export type ChallengePurpose = "setup" | "invitation" | "sign-in" | "recovery" | "add-passkey";

export const storeChallenge = Effect.fn("Authentication.storeChallenge")(function* (
  db: D1Database,
  purpose: ChallengePurpose,
  payload: Schema.Json,
) {
  const challengeBytes = new Uint8Array(SecureRandom.randomBytesUnsafe(32));
  const challengeHash = yield* sha256BytesHex(challengeBytes);
  const now = yield* Clock.currentTimeMillis;
  const id = SecureRandom.uuidV4Unsafe();
  const payloadJson = yield* encodeJson(payload).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  yield* Effect.tryPromise({
    try: () =>
      db.batch([
        db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
        db
          .prepare(
            "INSERT INTO auth_challenges (id, purpose, challenge_hash, payload_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .bind(id, purpose, challengeHash, payloadJson, now + challengeLifetimeMillis, now),
      ]),
    catch: () => AuthUnavailable.make(),
  });
  return Base64Url.encode(challengeBytes);
});

export const consumeChallenge = Effect.fn("Authentication.consumeChallenge")(function* (
  db: D1Database,
  purpose: ChallengePurpose,
  challengeBytes: Uint8Array<ArrayBuffer>,
) {
  const challengeHash = yield* sha256BytesHex(challengeBytes);
  const now = yield* Clock.currentTimeMillis;
  const row = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(
          "DELETE FROM auth_challenges WHERE challenge_hash = ? AND purpose = ? AND expires_at > ? RETURNING payload_json AS payloadJson",
        )
        .bind(challengeHash, purpose, now)
        .first(),
    catch: () => AuthUnavailable.make(),
  });
  if (row === null) return yield* PasskeyInvalid.make();
  const decoded = yield* decodeChallengeRow(row).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  return decoded.payloadJson;
});

export function creationOptions(input: {
  readonly challenge: string;
  readonly rpId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly excludeCredentials?: ReadonlyArray<{
    readonly id: string;
    readonly type: "public-key";
    readonly transports?: ReadonlyArray<string>;
  }>;
}): PasskeyCreationOptions {
  return {
    challenge: input.challenge,
    rp: { name: "Rondyr", id: input.rpId },
    user: {
      id: Base64Url.encode(encoder.encode(input.userId)),
      name: input.email,
      displayName: input.name,
    },
    pubKeyCredParams: supportedPasskeyAlgorithms,
    timeout: challengeLifetimeMillis,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    ...(input.excludeCredentials !== undefined &&
      input.excludeCredentials.length > 0 && {
        excludeCredentials: input.excludeCredentials,
      }),
  };
}

const parseTransports = (raw: string | null): ReadonlyArray<string> | undefined => {
  if (raw === null) return undefined;
  return Option.getOrUndefined(decodeTransports(raw));
};

export const userExcludedCredentials = Effect.fn("Authentication.userExcludedCredentials")(
  function* (db: D1Database, userId: typeof UserId.Type) {
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            "SELECT credential_id AS credentialId, transports FROM auth_passkeys WHERE user_id = ?",
          )
          .bind(userId)
          .all(),
      catch: () => AuthUnavailable.make(),
    });
    const decoded = yield* decodeCredentialIds(rows.results).pipe(
      Effect.mapError(() => AuthUnavailable.make()),
    );
    return decoded.map(({ credentialId, transports }) => {
      const parsedTransports = parseTransports(transports);
      return {
        id: credentialId,
        type: "public-key" as const,
        ...(parsedTransports !== undefined && { transports: parsedTransports }),
      };
    });
  },
);

export const toPasskeySummary = (
  row: typeof StoredPasskeyRow.Type,
  currentRpId: string,
): PasskeySummary => ({
  id: row.id,
  name: row.name,
  rpId: row.rpId,
  currentDomain: row.rpId === currentRpId,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
});
