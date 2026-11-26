import { constantTimeEqual } from "@oslojs/crypto/subtle";
import { Clock, Effect, Layer, Option, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { Base64Url, Hex } from "effect/encoding";

import { PasskeyId } from "../../../domain/organizations/account.ts";
import {
  challengeLifetimeMillis,
  otpLifetimeMillis,
  otpMaxAttempts,
  otpMaxCodesPerHour,
  sessionLifetimeMillis,
  sessionSlideThresholdMillis,
  type AuthSession,
  type PasskeyAssertionCredential,
  type PasskeyCreationOptions,
  type PasskeyRegistrationCredential,
  type PasskeyRequestOptions,
  type PasskeySummary,
} from "../../../domain/organizations/authentication.ts";
import {
  recoveryEnabled,
  recoveryTokenLength,
  setupState as stateOf,
  setupTokenLength,
  type AuthStatus,
} from "../../../domain/organizations/setup.ts";
import { UserId } from "../../../domain/submissions/submission.id.ts";
import {
  Authentication,
  AuthOriginRefused,
  AuthUnavailable,
  LastPasskey,
  OtpInvalid,
  PasskeyExists,
  PasskeyInvalid,
  PasskeyNotFound,
  RecoveryClosed,
  SetupClosed,
  SetupRateLimited,
  type AuthenticatedSession,
  type IssuedEmailOtp,
  type PreparedPasskeyRow,
  type PreparedSessionRow,
  type SessionResult,
  type VerifiedInvitationRegistration,
  type VerifiedOrigin,
} from "../../ports/authentication.ts";
import { EmailSender } from "../../ports/email-sender.ts";
import { rateLimitedClient } from "../workers/client-rate-limit.ts";
import {
  parseAssertionClientData,
  parseRegistrationClientData,
  supportedPasskeyAlgorithms,
  verifyAssertionSignature,
  verifyRegistrationAttestation,
} from "./webauthn.ts";

const encoder = new TextEncoder();
const hourMillis = 60 * 60 * 1000;
const defaultPasskeyName = "Passkey";

const OptionalNonEmpty = Schema.optionalKey(Schema.String);
const EnvSecrets = Schema.Struct({
  RONDYR_SESSION_SECRET: OptionalNonEmpty,
  BETTER_AUTH_SECRET: OptionalNonEmpty,
  RONDYR_PUBLIC_URL: OptionalNonEmpty,
  BETTER_AUTH_URL: OptionalNonEmpty,
  RONDYR_SETUP_TOKEN: OptionalNonEmpty,
  RONDYR_RECOVERY_TOKEN: OptionalNonEmpty,
});

const SetupChallengePayload = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
});
const RecoveryChallengePayload = Schema.Struct({
  userId: UserId,
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

const SessionRow = Schema.Struct({
  sessionId: Schema.String,
  expiresAt: Schema.Int,
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
});
const UserRow = Schema.Struct({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
});
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
const StoredPasskeyRow = Schema.Struct({
  id: PasskeyId,
  name: Schema.String,
  rpId: Schema.String,
  createdAt: Schema.Int,
  lastUsedAt: Schema.NullOr(Schema.Int),
});
const CredentialIdRow = Schema.Struct({
  credentialId: Schema.String,
  transports: Schema.NullOr(Schema.String),
});
const ChallengeRow = Schema.Struct({
  payloadJson: Schema.String,
});
const OtpRow = Schema.Struct({
  id: Schema.String,
  codeHash: Schema.String,
  attempts: Schema.Int,
});
const CountRow = Schema.Struct({ total: Schema.Int });
const ExistsRow = Schema.Struct({ stillExists: Schema.Literals([0, 1]) });

const decodeEnv = Schema.decodeUnknownEffect(EnvSecrets);
const decodeSessionRow = Schema.decodeUnknownEffect(SessionRow);
const decodeUserRow = Schema.decodeUnknownEffect(UserRow);
const decodePasskeyAuthRow = Schema.decodeUnknownEffect(PasskeyAuthRow);
const decodeStoredPasskeys = Schema.decodeUnknownEffect(Schema.Array(StoredPasskeyRow));
const decodeStoredPasskey = Schema.decodeUnknownEffect(StoredPasskeyRow);
const decodeCredentialIds = Schema.decodeUnknownEffect(Schema.Array(CredentialIdRow));
const decodeChallengeRow = Schema.decodeUnknownEffect(ChallengeRow);
const decodeOtpRow = Schema.decodeUnknownEffect(OtpRow);
const decodeCountRow = Schema.decodeUnknownEffect(CountRow);
const decodeExistsRow = Schema.decodeUnknownEffect(ExistsRow);
const decodeSetupPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(SetupChallengePayload));
const decodeRecoveryPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RecoveryChallengePayload),
);
const decodeInvitationPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(InvitationChallengePayload),
);
const decodeAddPasskeyPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AddPasskeyChallengePayload),
);

function loopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

const bindings = Effect.promise(() => import("cloudflare:workers")).pipe(
  Effect.map(({ env }) => env),
);

const sha256Bytes = Effect.fnUntraced(function* (input: Uint8Array<ArrayBuffer>) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", input),
    catch: () => AuthUnavailable.make(),
  });
  return new Uint8Array(digest);
});

const sha256Hex = Effect.fnUntraced(function* (input: string) {
  const digest = yield* sha256Bytes(new Uint8Array(encoder.encode(input)));
  return Hex.encode(digest);
});

const sha256BytesHex = Effect.fnUntraced(function* (input: Uint8Array<ArrayBuffer>) {
  const digest = yield* sha256Bytes(input);
  return Hex.encode(digest);
});

/** Constant-time equality over arbitrary strings via SHA-256 digests. */
const equalSecrets = Effect.fnUntraced(function* (left: string, right: string) {
  const [a, b] = yield* Effect.all([
    sha256Bytes(new Uint8Array(encoder.encode(left))),
    sha256Bytes(new Uint8Array(encoder.encode(right))),
  ]);
  return constantTimeEqual(a, b);
});

const hmacSessionToken = Effect.fnUntraced(function* (
  secret: Redacted.Redacted<string>,
  token: string,
) {
  const key = yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        encoder.encode(Redacted.value(secret)),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    catch: () => AuthUnavailable.make(),
  });
  const mac = yield* Effect.tryPromise({
    try: () => crypto.subtle.sign("HMAC", key, encoder.encode(token)),
    catch: () => AuthUnavailable.make(),
  });
  return Hex.encode(new Uint8Array(mac));
});

function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-rondyr_session" : "rondyr_session";
}

function formatSessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  const base = `${sessionCookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  return secure ? `${base}; Secure` : base;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

/** Generate an unbiased 6-digit numeric OTP code using Web Crypto CSPRNG. */
function generateOtpCode(): string {
  const max = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  while (true) {
    const bytes = SecureRandom.randomBytesUnsafe(4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, 4);
    const value = view.getUint32(0, false);
    if (value < limit) return String(value % max).padStart(6, "0");
  }
}

function requestMetadata(request: Request) {
  const ip = request.headers.get("cf-connecting-ip");
  const ua = request.headers.get("user-agent");
  return {
    ipAddress: ip !== null && ip !== "" ? ip.slice(0, 64) : null,
    userAgent: ua !== null && ua !== "" ? ua.slice(0, 512) : null,
  };
}

interface AuthConfig extends VerifiedOrigin {
  readonly sessionSecret: Redacted.Redacted<string>;
  readonly setupToken: Option.Option<Redacted.Redacted<string>>;
  readonly recoveryToken: Option.Option<Redacted.Redacted<string>>;
}

const readConfig = Effect.fn("Authentication.readConfig")(function* (request: Request) {
  const env = yield* bindings;
  const parsed = yield* decodeEnv(env).pipe(Effect.mapError(() => AuthUnavailable.make()));
  const rawSecret = nonEmpty(parsed.RONDYR_SESSION_SECRET) ?? nonEmpty(parsed.BETTER_AUTH_SECRET);
  if (rawSecret === undefined || rawSecret.length < setupTokenLength.minimum) {
    return yield* AuthUnavailable.make();
  }
  const configuredUrl = nonEmpty(parsed.RONDYR_PUBLIC_URL) ?? nonEmpty(parsed.BETTER_AUTH_URL);
  const incoming = new URL(request.url);
  // Without RONDYR_PUBLIC_URL (or BETTER_AUTH_URL), the Worker's origin is the request's:
  // Cloudflare routes to a Worker only the hostnames its account assigns to it, so a request
  // cannot name another site. It must be HTTPS on the default port (or loopback HTTP locally).
  const baseURL = yield* Effect.try({
    try: () => new URL(configuredUrl ?? incoming.origin),
    catch: () => AuthUnavailable.make(),
  });
  if (configuredUrl === undefined && baseURL.port !== "" && !loopback(baseURL)) {
    return yield* AuthUnavailable.make();
  }
  if (
    baseURL.href !== `${baseURL.origin}/` ||
    (baseURL.protocol !== "https:" && !loopback(baseURL))
  ) {
    return yield* AuthUnavailable.make();
  }
  const originHeader = request.headers.get("origin");
  if (
    incoming.origin !== baseURL.origin ||
    (originHeader !== null && originHeader !== baseURL.origin)
  ) {
    return yield* AuthOriginRefused.make();
  }
  const setupRaw = nonEmpty(parsed.RONDYR_SETUP_TOKEN);
  const recoveryRaw = nonEmpty(parsed.RONDYR_RECOVERY_TOKEN);
  return {
    origin: baseURL.origin,
    rpId: baseURL.hostname,
    secure: baseURL.protocol === "https:",
    sessionSecret: Redacted.make(rawSecret),
    setupToken: setupRaw !== undefined ? Option.some(Redacted.make(setupRaw)) : Option.none(),
    recoveryToken:
      recoveryRaw !== undefined ? Option.some(Redacted.make(recoveryRaw)) : Option.none(),
  } satisfies AuthConfig;
});

const admitTokenAttempt = Effect.fn("Authentication.admitTokenAttempt")(function* (
  scope: "setup" | "recovery",
  request: Request,
) {
  const client = request.headers.get("cf-connecting-ip");
  if (client === null || client === "") return true;
  const env = yield* bindings;
  return yield* Effect.tryPromise({
    try: () => env.CLIENT_RATE_LIMIT.limit({ key: `${scope}:${rateLimitedClient(client)}` }),
    catch: () => AuthUnavailable.make(),
  }).pipe(
    Effect.map(({ success }) => success),
    Effect.tapError(() =>
      Effect.logWarning("Token rate limit unavailable; attempt admitted", { scope }),
    ),
    Effect.orElseSucceed(() => true),
  );
});

const accountExists = Effect.fn("Authentication.accountExists")(function* (database: D1Database) {
  const existing = yield* Effect.tryPromise({
    try: () => database.prepare("SELECT 1 FROM auth_users LIMIT 1").first(),
    catch: () => AuthUnavailable.make(),
  });
  return existing !== null;
});

const decodeTransports = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const storeChallenge = Effect.fn("Authentication.storeChallenge")(function* (
  db: D1Database,
  purpose: "setup" | "invitation" | "sign-in" | "recovery" | "add-passkey",
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

const consumeChallenge = Effect.fn("Authentication.consumeChallenge")(function* (
  db: D1Database,
  purpose: "setup" | "invitation" | "sign-in" | "recovery" | "add-passkey",
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

function creationOptions(input: {
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
      userVerification: "preferred",
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

const userExcludedCredentials = Effect.fn("Authentication.userExcludedCredentials")(function* (
  db: D1Database,
  userId: typeof UserId.Type,
) {
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
});

const prepareSession = Effect.fn("Authentication.prepareSession")(function* (
  config: AuthConfig,
  request: Request,
  now: number,
) {
  const rawToken = Base64Url.encode(SecureRandom.randomBytesUnsafe(32));
  const tokenHash = yield* hmacSessionToken(config.sessionSecret, rawToken);
  const { ipAddress, userAgent } = requestMetadata(request);
  const session: PreparedSessionRow = {
    id: SecureRandom.uuidV4Unsafe(),
    tokenHash,
    expiresAt: now + sessionLifetimeMillis,
    ipAddress,
    userAgent,
  };
  const setCookie = formatSessionCookie(
    rawToken,
    config.secure,
    Math.floor(sessionLifetimeMillis / 1000),
  );
  return { session, setCookie };
});

const toPasskeySummary = (
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

export const authenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const emailSender = yield* EmailSender;

    const verifyOrigin = Effect.fn("Authentication.verifyOrigin")(function* (request: Request) {
      const { origin, rpId, secure } = yield* readConfig(request);
      return { origin, rpId, secure } satisfies VerifiedOrigin;
    });

    const getSession = Effect.fn("Authentication.getSession")(function* (request: Request) {
      const config = yield* readConfig(request);
      const rawToken = readCookie(request, sessionCookieName(config.secure));
      if (rawToken === null) return { session: null, setCookie: null } satisfies SessionResult;
      const tokenHash = yield* hmacSessionToken(config.sessionSecret, rawToken);
      const env = yield* bindings;
      const now = yield* Clock.currentTimeMillis;
      const row = yield* Effect.tryPromise({
        try: () =>
          env.DB.prepare(`
            SELECT s.id AS sessionId, s.expires_at AS expiresAt, u.id AS userId, u.name, u.email
            FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
            WHERE s.token = ? AND s.expires_at > ?
          `)
            .bind(tokenHash, now)
            .first(),
        catch: () => AuthUnavailable.make(),
      });
      if (row === null) return { session: null, setCookie: null } satisfies SessionResult;
      const found = yield* decodeSessionRow(row).pipe(
        Effect.mapError(() => AuthUnavailable.make()),
      );
      let setCookie: string | null = null;
      if (found.expiresAt - now < sessionSlideThresholdMillis) {
        const nextExpiry = now + sessionLifetimeMillis;
        yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare("UPDATE auth_sessions SET expires_at = ?, updated_at = ? WHERE id = ?")
              .bind(nextExpiry, now, found.sessionId)
              .run(),
          catch: () => AuthUnavailable.make(),
        });
        setCookie = formatSessionCookie(
          rawToken,
          config.secure,
          Math.floor(sessionLifetimeMillis / 1000),
        );
      }
      const session: AuthSession = {
        user: { id: found.userId, name: found.name, email: found.email },
      };
      return { session, setCookie } satisfies SessionResult;
    });

    const userId = Effect.fn("Authentication.userId")(function* (request: Request) {
      const { session } = yield* getSession(request);
      return session?.user.id ?? null;
    });

    const signOut = Effect.fn("Authentication.signOut")(function* (request: Request) {
      const config = yield* readConfig(request);
      const rawToken = readCookie(request, sessionCookieName(config.secure));
      if (rawToken !== null) {
        const tokenHash = yield* hmacSessionToken(config.sessionSecret, rawToken);
        const env = yield* bindings;
        yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare("DELETE FROM auth_sessions WHERE token = ?").bind(tokenHash).run(),
          catch: () => AuthUnavailable.make(),
        });
      }
      return formatSessionCookie("", config.secure, 0);
    });

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
      const matches = yield* equalSecrets(
        header,
        `Bearer ${Redacted.value(config.setupToken.value)}`,
      );
      if (!matches) return yield* SetupClosed.make();
      return config;
    });

    const setupOptions = Effect.fn("Authentication.setupOptions")(function* (
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

    const setupVerify = Effect.fn("Authentication.setupVerify")(function* (
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
      const label = passkeyName ?? defaultPasskeyName;

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

    const passkeySignInOptions = Effect.fn("Authentication.passkeySignInOptions")(function* (
      request: Request,
    ) {
      const config = yield* readConfig(request);
      const env = yield* bindings;
      const challenge = yield* storeChallenge(env.DB, "sign-in", {});
      return {
        challenge,
        rpId: config.rpId,
        timeout: challengeLifetimeMillis,
        userVerification: "preferred",
        allowCredentials: [],
      } satisfies PasskeyRequestOptions;
    });

    const passkeySignInVerify = Effect.fn("Authentication.passkeySignInVerify")(function* (
      request: Request,
      credential: PasskeyAssertionCredential,
    ) {
      const config = yield* readConfig(request);
      const env = yield* bindings;
      const { challenge, clientDataBytes } = yield* parseAssertionClientData(
        credential,
        config.origin,
      );
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

    const issueEmailOtp = Effect.fn("Authentication.issueEmailOtp")(function* (rawEmail: string) {
      const env = yield* bindings;
      const email = rawEmail.toLowerCase();
      const now = yield* Clock.currentTimeMillis;
      const [userFound, recentCount] = yield* Effect.tryPromise({
        try: () =>
          env.DB.batch([
            env.DB.prepare("SELECT id FROM auth_users WHERE lower(email) = ? LIMIT 1").bind(email),
            env.DB.prepare(
              "SELECT count(*) AS total FROM auth_email_otps WHERE email = ? AND created_at > ?",
            ).bind(email, now - hourMillis),
          ]),
        catch: () => AuthUnavailable.make(),
      });
      if (userFound === undefined || userFound.results.length === 0) return null;
      const { total } = yield* decodeCountRow(recentCount?.results[0]).pipe(
        Effect.mapError(() => AuthUnavailable.make()),
      );
      if (total >= otpMaxCodesPerHour) return null;

      const id = SecureRandom.uuidV4Unsafe();
      const code = generateOtpCode();
      const codeHash = yield* sha256Hex(`${id}:${email}:${code}`);
      yield* Effect.tryPromise({
        try: () =>
          env.DB.batch([
            env.DB.prepare(
              "UPDATE auth_email_otps SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL",
            ).bind(now, email),
            env.DB.prepare(`
              INSERT INTO auth_email_otps (id, email, code_hash, attempts, expires_at, consumed_at, created_at)
              VALUES (?, ?, ?, 0, ?, NULL, ?)
            `).bind(id, email, codeHash, now + otpLifetimeMillis, now),
          ]),
        catch: () => AuthUnavailable.make(),
      });
      return { email, code } satisfies IssuedEmailOtp;
    });

    const verifyEmailOtp = Effect.fn("Authentication.verifyEmailOtp")(function* (
      request: Request,
      rawEmail: string,
      code: string,
    ) {
      const config = yield* readConfig(request);
      const env = yield* bindings;
      const email = rawEmail.toLowerCase();
      const now = yield* Clock.currentTimeMillis;
      const [otpResult, userResult] = yield* Effect.tryPromise({
        try: () =>
          env.DB.batch([
            env.DB.prepare(`
              SELECT id, code_hash AS codeHash, attempts
              FROM auth_email_otps
              WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
              ORDER BY created_at DESC LIMIT 1
            `).bind(email, now),
            env.DB.prepare(
              "SELECT id, name, email FROM auth_users WHERE lower(email) = ? LIMIT 1",
            ).bind(email),
          ]),
        catch: () => AuthUnavailable.make(),
      });
      const otpRaw = otpResult?.results[0];
      const userRaw = userResult?.results[0];
      if (otpRaw === undefined || userRaw === undefined) return yield* OtpInvalid.make();
      const otp = yield* decodeOtpRow(otpRaw).pipe(Effect.mapError(() => AuthUnavailable.make()));
      const user = yield* decodeUserRow(userRaw).pipe(
        Effect.mapError(() => AuthUnavailable.make()),
      );

      const candidateHash = yield* sha256Hex(`${otp.id}:${email}:${code}`);
      const matches = yield* equalSecrets(candidateHash, otp.codeHash);
      if (!matches) {
        yield* Effect.tryPromise({
          try: () =>
            env.DB.prepare(`
              UPDATE auth_email_otps
              SET attempts = attempts + 1,
                  consumed_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE NULL END
              WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
            `)
              .bind(otpMaxAttempts, now, otp.id, now)
              .run(),
          catch: () => AuthUnavailable.make(),
        });
        return yield* OtpInvalid.make();
      }

      const consumed = yield* Effect.tryPromise({
        try: () =>
          env.DB.prepare(`
            UPDATE auth_email_otps SET consumed_at = ?
            WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < ?
            RETURNING id
          `)
            .bind(now, otp.id, now, otpMaxAttempts)
            .all(),
        catch: () => AuthUnavailable.make(),
      });
      if (consumed.results.length !== 1) return yield* OtpInvalid.make();

      const { session, setCookie } = yield* prepareSession(config, request, now);
      yield* Effect.tryPromise({
        try: () =>
          env.DB.batch([
            env.DB.prepare(
              "UPDATE auth_users SET email_verified = 1, updated_at = ? WHERE id = ?",
            ).bind(now, user.id),
            env.DB.prepare(`
              INSERT INTO auth_sessions
                (id, token, user_id, expires_at, created_at, updated_at, ip_address, user_agent)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              session.id,
              session.tokenHash,
              user.id,
              session.expiresAt,
              now,
              now,
              session.ipAddress,
              session.userAgent,
            ),
          ]),
        catch: () => AuthUnavailable.make(),
      });
      return {
        session: { user: { id: user.id, name: user.name, email: user.email } },
        setCookie,
      } satisfies AuthenticatedSession;
    });

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

    const recoveryOptions = Effect.fn("Authentication.recoveryOptions")(function* (
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

    const recoveryVerify = Effect.fn("Authentication.recoveryVerify")(function* (
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
      const label = passkeyName ?? defaultPasskeyName;

      const [inserted] = yield* Effect.tryPromise({
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
          ]),
        catch: () => AuthUnavailable.make(),
      });
      if (inserted?.meta.changes !== 1) return yield* PasskeyExists.make();
      return {
        session: { user: { id: payload.userId, name: payload.name, email: payload.email } },
        setCookie,
      } satisfies AuthenticatedSession;
    });

    const invitationOptions = Effect.fn("Authentication.invitationOptions")(function* (
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

    const invitationVerify = Effect.fn("Authentication.invitationVerify")(function* (
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
        name: passkeyName ?? defaultPasskeyName,
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

    const listPasskeys = Effect.fn("Authentication.listPasskeys")(function* (
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

    const addPasskeyOptions = Effect.fn("Authentication.addPasskeyOptions")(function* (
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

    const addPasskeyVerify = Effect.fn("Authentication.addPasskeyVerify")(function* (
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
      const label = name ?? defaultPasskeyName;
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

    const renamePasskey = Effect.fn("Authentication.renamePasskey")(function* (
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

    const deletePasskey = Effect.fn("Authentication.deletePasskey")(function* (
      userIdValue: typeof UserId.Type,
      passkeyId: PasskeyId,
      allowDeleteLast: boolean,
    ) {
      const env = yield* bindings;
      const allow = allowDeleteLast ? 1 : 0;
      const [deleted, remaining] = yield* Effect.tryPromise({
        try: () =>
          env.DB.batch([
            env.DB.prepare(`
              DELETE FROM auth_passkeys
              WHERE id = ?1 AND user_id = ?2
                AND (?3 = 1 OR (SELECT count(*) FROM auth_passkeys WHERE user_id = ?2) > 1)
              RETURNING id
            `).bind(passkeyId, userIdValue, allow),
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

    const purgeExpired = Effect.fn("Authentication.purgeExpired")(function* (now: number) {
      const env = yield* bindings;
      const otpCutoff = now - 2 * hourMillis;
      yield* Effect.tryPromise({
        try: () =>
          env.DB.batch([
            env.DB.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").bind(now),
            env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(now),
            env.DB.prepare("DELETE FROM auth_email_otps WHERE created_at <= ?").bind(otpCutoff),
          ]),
        catch: () => AuthUnavailable.make(),
      });
    });

    return {
      verifyOrigin,
      userId,
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
    } satisfies Authentication["Service"];
  }),
);
