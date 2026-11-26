import { constantTimeEqual } from "@oslojs/crypto/subtle";
import { Effect, Option, Redacted, Schema } from "effect";
import { Hex } from "effect/encoding";

import { setupTokenLength } from "../../../domain/organizations/setup.ts";
import { UserId } from "../../../domain/submissions/submission.id.ts";
import {
  AuthOriginRefused,
  AuthUnavailable,
  type VerifiedOrigin,
} from "../../ports/authentication.ts";
import { rateLimitedClient } from "../workers/client-rate-limit.ts";

export const encoder = new TextEncoder();

export const hourMillis = 60 * 60 * 1000;

export const dayMillis = 24 * hourMillis;

const OptionalNonEmpty = Schema.optionalKey(Schema.String);
const EnvSecrets = Schema.Struct({
  RONDYR_SESSION_SECRET: OptionalNonEmpty,
  BETTER_AUTH_SECRET: OptionalNonEmpty,
  RONDYR_PUBLIC_URL: OptionalNonEmpty,
  BETTER_AUTH_URL: OptionalNonEmpty,
  RONDYR_SETUP_TOKEN: OptionalNonEmpty,
  RONDYR_RECOVERY_TOKEN: OptionalNonEmpty,
});

const UserRow = Schema.Struct({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
});

const ExistsRow = Schema.Struct({ stillExists: Schema.Literals([0, 1]) });

export const decodeEnv = Schema.decodeUnknownEffect(EnvSecrets);

export const decodeUserRow = Schema.decodeUnknownEffect(UserRow);

export const decodeExistsRow = Schema.decodeUnknownEffect(ExistsRow);

export const bindings = Effect.promise(() => import("cloudflare:workers")).pipe(
  Effect.map(({ env }) => env),
);

/**
 * Local development over HTTP. Only `localhost` counts: the hostname is also the WebAuthn
 * RP ID, and browsers refuse an IP address such as `127.0.0.1` there.
 */
function loopback(url: URL): boolean {
  return url.protocol === "http:" && url.hostname === "localhost";
}

export function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== "" ? value : undefined;
}

export const sha256Bytes = Effect.fnUntraced(function* (input: Uint8Array<ArrayBuffer>) {
  const digest = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", input),
    catch: () => AuthUnavailable.make(),
  });
  return new Uint8Array(digest);
});

export const sha256Hex = Effect.fnUntraced(function* (input: string) {
  const digest = yield* sha256Bytes(new Uint8Array(encoder.encode(input)));
  return Hex.encode(digest);
});

export const sha256BytesHex = Effect.fnUntraced(function* (input: Uint8Array<ArrayBuffer>) {
  const digest = yield* sha256Bytes(input);
  return Hex.encode(digest);
});

/** Constant-time equality over arbitrary strings via SHA-256 digests. */
export const equalSecrets = Effect.fnUntraced(function* (left: string, right: string) {
  const [a, b] = yield* Effect.all([
    sha256Bytes(new Uint8Array(encoder.encode(left))),
    sha256Bytes(new Uint8Array(encoder.encode(right))),
  ]);
  return constantTimeEqual(a, b);
});

export interface AuthConfig extends VerifiedOrigin {
  readonly sessionSecret: Redacted.Redacted<string>;
  readonly setupToken: Option.Option<Redacted.Redacted<string>>;
  readonly recoveryToken: Option.Option<Redacted.Redacted<string>>;
}

export const readConfig = Effect.fn("Authentication.readConfig")(function* (request: Request) {
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

export const verifyOrigin = Effect.fn("Authentication.verifyOrigin")(function* (request: Request) {
  const { origin, rpId, secure } = yield* readConfig(request);
  return { origin, rpId, secure } satisfies VerifiedOrigin;
});

export const admitTokenAttempt = Effect.fn("Authentication.admitTokenAttempt")(function* (
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

export const accountExists = Effect.fn("Authentication.accountExists")(function* (
  database: D1Database,
) {
  const existing = yield* Effect.tryPromise({
    try: () => database.prepare("SELECT 1 FROM auth_users LIMIT 1").first(),
    catch: () => AuthUnavailable.make(),
  });
  return existing !== null;
});
