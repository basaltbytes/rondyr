import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { constantTimeEqual, hashPassword } from "better-auth/crypto";
import { betterAuth } from "better-auth/minimal";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import {
  Authentication,
  AuthOriginRefused,
  AuthUnavailable,
  InvalidSetup,
  SetupClosed,
} from "../../ports/authentication.ts";
import * as schema from "../database/auth-schema.ts";

const Secret = Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32)));
const BindingConfig = Schema.Struct({
  BETTER_AUTH_SECRET: Secret,
  BETTER_AUTH_URL: Schema.optional(Schema.String),
});
const SetupConfig = Schema.Struct({ RONDYR_SETUP_TOKEN: Secret });
const OwnerInput = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  email: Schema.Trim.check(
    Schema.isMaxLength(254),
    // Match the email format accepted by Better Auth's sign-in endpoint.
    Schema.isPattern(
      /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/u,
    ),
  ),
  password: Schema.RedactedFromValue(
    Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(128)),
  ),
});

function loopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

const readConfig = Effect.fn("Authentication.readConfig")(function* (request: Request) {
  const settings = yield* Schema.decodeUnknownEffect(BindingConfig)(env).pipe(
    Effect.mapError(() => AuthUnavailable.make()),
  );
  const incoming = new URL(request.url);
  const baseURL = yield* Effect.try({
    try: () => new URL(settings.BETTER_AUTH_URL ?? incoming.origin),
    catch: () => AuthUnavailable.make(),
  });
  if (settings.BETTER_AUTH_URL === undefined && !loopback(baseURL)) {
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
  return { origin: baseURL.origin, settings };
});

const handle = Effect.fn("Authentication.handle")(function* (request: Request) {
  const { origin, settings } = yield* readConfig(request);
  const auth = betterAuth({
    appName: "Rondyr",
    baseURL: origin,
    secret: Redacted.value(settings.BETTER_AUTH_SECRET),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    database: drizzleAdapter(drizzle(env.DB), { provider: "sqlite", schema }),
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    rateLimit: { enabled: true, storage: "database" },
    telemetry: { enabled: false },
    logger: { disabled: true },
  });
  return yield* Effect.tryPromise({
    try: () => auth.handler(request),
    catch: () => AuthUnavailable.make(),
  });
});

const setup = Effect.fn("Authentication.setup")(function* (request: Request) {
  const { RONDYR_SETUP_TOKEN: token } = yield* Schema.decodeUnknownEffect(SetupConfig)(env).pipe(
    Effect.mapError(() => SetupClosed.make()),
  );
  if (
    !constantTimeEqual(
      request.headers.get("authorization") ?? "",
      `Bearer ${Redacted.value(token)}`,
    )
  ) {
    return yield* SetupClosed.make();
  }
  yield* readConfig(request);

  const dbBinding = env.DB;
  const existing = yield* Effect.tryPromise({
    try: () => dbBinding.prepare("SELECT 1 FROM auth_users LIMIT 1").first(),
    catch: () => AuthUnavailable.make(),
  });
  if (existing !== null) return yield* SetupClosed.make();

  const input = yield* Effect.tryPromise({
    try: () => request.json(),
    catch: () => InvalidSetup.make(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(OwnerInput, { onExcessProperty: "error" })),
    Effect.mapError(() => InvalidSetup.make()),
  );
  const password = yield* Effect.tryPromise({
    try: () => hashPassword(Redacted.value(input.password)),
    catch: () => AuthUnavailable.make(),
  });
  const id = SecureRandom.uuidV4Unsafe();
  const now = yield* Clock.currentTimeMillis;
  const email = input.email.toLowerCase();

  // D1 executes the batch atomically. A racing request can only insert an account
  // when its own user ID was inserted by the first statement.
  const [inserted] = yield* Effect.tryPromise({
    try: () =>
      dbBinding.batch([
        dbBinding
          .prepare(`
            INSERT INTO auth_users (id, name, email, created_at, updated_at)
            SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM auth_users)
          `)
          .bind(id, input.name, email, now, now),
        dbBinding
          .prepare(`
            INSERT INTO auth_accounts (id, user_id, account_id, provider_id, password, created_at, updated_at)
            SELECT ?, ?, ?, 'credential', ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM auth_users WHERE id = ?)
          `)
          .bind(id, id, id, password, now, now, id),
      ]),
    catch: () => AuthUnavailable.make(),
  });
  if (inserted?.meta.changes !== 1) return yield* SetupClosed.make();
});

export const authenticationLive = Layer.succeed(Authentication, { handle, setup });
