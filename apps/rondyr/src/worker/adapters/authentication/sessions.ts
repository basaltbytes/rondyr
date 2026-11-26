import { Clock, Effect, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { Base64Url, Hex } from "effect/encoding";

import {
  sessionLifetimeMillis,
  sessionSlideThresholdMillis,
  type AuthSession,
} from "../../../domain/organizations/authentication.ts";
import { UserId } from "../../../domain/submissions/submission.id.ts";
import {
  AuthUnavailable,
  type PreparedSessionRow,
  type SessionResult,
} from "../../ports/authentication.ts";
import { bindings, dayMillis, encoder, readConfig, type AuthConfig } from "./config.ts";

const SessionRow = Schema.Struct({
  sessionId: Schema.String,
  expiresAt: Schema.Int,
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
});

const decodeSessionRow = Schema.decodeUnknownEffect(SessionRow);

export const hmacSessionToken = Effect.fnUntraced(function* (
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

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-rondyr_session" : "rondyr_session";
}

function formatSessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  const base = `${sessionCookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  return secure ? `${base}; Secure` : base;
}

export function readCookie(request: Request, name: string): string | null {
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

function requestMetadata(request: Request) {
  const ip = request.headers.get("cf-connecting-ip");
  const ua = request.headers.get("user-agent");
  return {
    ipAddress: ip !== null && ip !== "" ? ip.slice(0, 64) : null,
    userAgent: ua !== null && ua !== "" ? ua.slice(0, 512) : null,
  };
}

export const prepareSession = Effect.fn("Authentication.prepareSession")(function* (
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

export const getSession = Effect.fn("Authentication.getSession")(function* (request: Request) {
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
  const found = yield* decodeSessionRow(row).pipe(Effect.mapError(() => AuthUnavailable.make()));
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

export const signOut = Effect.fn("Authentication.signOut")(function* (request: Request) {
  const config = yield* readConfig(request);
  const rawToken = readCookie(request, sessionCookieName(config.secure));
  if (rawToken !== null) {
    const tokenHash = yield* hmacSessionToken(config.sessionSecret, rawToken);
    const env = yield* bindings;
    yield* Effect.tryPromise({
      try: () => env.DB.prepare("DELETE FROM auth_sessions WHERE token = ?").bind(tokenHash).run(),
      catch: () => AuthUnavailable.make(),
    });
  }
  return formatSessionCookie("", config.secure, 0);
});

export const purgeExpired = Effect.fn("Authentication.purgeExpired")(function* (now: number) {
  const env = yield* bindings;
  // The daily cap of email codes counts the rows of the last 24 hours.
  const otpCutoff = now - dayMillis;
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
