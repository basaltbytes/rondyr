import { Clock, Effect, Layer, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { AccountEmail, AccountName, AccountPassword } from "../../domain/organizations/account.ts";
import {
  Authentication,
  AuthOriginRefused,
  AuthUnavailable,
  InvalidSetup,
  SetupClosed,
} from "../../ports/authentication.ts";

const Secret = Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(32)));
const BindingConfig = Schema.Struct({
  BETTER_AUTH_SECRET: Secret,
  BETTER_AUTH_URL: Schema.optional(Schema.String),
});
const SetupConfig = Schema.Struct({ RONDYR_SETUP_TOKEN: Secret });
// An invited person chooses a name and a password with the same rules.
const OwnerInput = Schema.Struct({
  name: AccountName,
  email: AccountEmail,
  password: AccountPassword,
});

function loopback(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

const bindings = Effect.promise(() => import("cloudflare:workers")).pipe(
  Effect.map(({ env }) => env),
);

const readConfig = Effect.fn("Authentication.readConfig")(function* (request: Request) {
  const env = yield* bindings;
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

const authFor = Effect.fn("Authentication.authFor")(function* (request: Request) {
  const { origin, settings } = yield* readConfig(request);
  // Keep the Better Auth dependencies out of the health and form request paths.
  const { createBetterAuth } = yield* Effect.tryPromise({
    try: () => import("./provider.ts"),
    catch: () => AuthUnavailable.make(),
  });
  const env = yield* bindings;
  return createBetterAuth(env.DB, origin, settings.BETTER_AUTH_SECRET);
});

const handle = Effect.fn("Authentication.handle")(function* (request: Request) {
  const auth = yield* authFor(request);
  return yield* Effect.tryPromise({
    try: () => auth.handler(request),
    catch: () => AuthUnavailable.make(),
  });
});

const userId = Effect.fn("Authentication.userId")(function* (request: Request) {
  const auth = yield* authFor(request);
  const session = yield* Effect.tryPromise({
    try: () => auth.api.getSession({ headers: request.headers }),
    catch: () => AuthUnavailable.make(),
  });
  return session?.user.id ?? null;
});

const setup = Effect.fn("Authentication.setup")(function* (request: Request) {
  const env = yield* bindings;
  const { RONDYR_SETUP_TOKEN: token } = yield* Schema.decodeUnknownEffect(SetupConfig)(env).pipe(
    Effect.mapError(() => SetupClosed.make()),
  );
  const header = request.headers.get("authorization");
  if (header === null) return yield* SetupClosed.make();

  const { constantTimeEqual, hashPassword } = yield* Effect.tryPromise({
    try: () => import("better-auth/crypto"),
    catch: () => AuthUnavailable.make(),
  });
  if (!constantTimeEqual(header, `Bearer ${Redacted.value(token)}`)) {
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

export const authenticationLive = Layer.succeed(Authentication, { handle, setup, userId });
