import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, describe, it } from "@effect/vitest";
import { Duration, Effect, Schedule, Schema } from "effect";

import {
  testOrigin,
  testRecoveryToken,
  testSetupToken,
} from "../../../tests/integration/auth-fixture.ts";
import { cookieOf } from "../../../tests/integration/organization-fixture.ts";
import {
  assertVirtualPasskey,
  registerVirtualPasskey,
  type VirtualPasskey,
} from "../../../tests/integration/webauthn-helper.mjs";
import {
  AccountPasskeys,
  PasskeyCreationOptions,
  PasskeyRequestOptions,
  PasskeySummary,
} from "../../domain/organizations/authentication.ts";
import { AuthStatus } from "../../domain/organizations/setup.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeStatus = Schema.decodeUnknownEffect(AuthStatus);
const decodeCreationOptions = Schema.decodeUnknownEffect(PasskeyCreationOptions);
const decodeRequestOptions = Schema.decodeUnknownEffect(PasskeyRequestOptions);
const decodeAccountPasskeys = Schema.decodeUnknownEffect(AccountPasskeys);
const decodePasskeySummary = Schema.decodeUnknownEffect(PasskeySummary);
const decodeSession = Schema.decodeUnknownEffect(
  Schema.Struct({ user: Schema.Struct({ email: Schema.String }) }),
);
const decodeEmails = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      body: Schema.fromJsonString(
        Schema.Struct({
          to: Schema.Array(Schema.String),
          subject: Schema.String,
          text: Schema.String,
        }),
      ),
    }),
  ),
);

const owner = {
  name: "Instance owner",
  email: "instance-owner@example.test",
};

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const authStatus = Effect.fnUntraced(function* (worker: Fetcher) {
  const response = yield* Effect.promise(() => worker.fetch(`${testOrigin}/api/auth/status`));
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  const body = yield* Effect.promise(() => response.json());
  return yield* decodeStatus(body);
});

const postJson = Effect.fnUntraced(function* (
  worker: Fetcher,
  url: string,
  data: Schema.Json,
  extra?: HeadersInit,
) {
  const body = yield* encodeJson(data);
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  if (!headers.has("origin")) headers.set("origin", new URL(url).origin);
  return yield* Effect.promise(() => worker.fetch(url, { method: "POST", headers, body }));
});

const requestSetupOptions = Effect.fnUntraced(function* (token: string, client: string) {
  return yield* postJson(env.TEST_WORKER, `${testOrigin}/api/setup/options`, owner, {
    authorization: `Bearer ${token}`,
    "cf-connecting-ip": client,
  });
});

const waitForOtpEmail = Effect.fnUntraced(function* (
  recipient: string,
  minimumCount: number,
  expectedSubjectFragment: string,
) {
  const readOnce = Effect.gen(function* () {
    const res = yield* Effect.promise(() =>
      env.RESEND_FIXTURE.fetch(
        `https://resend.test/__received?recipient=${encodeURIComponent(recipient)}`,
      ),
    );
    const raw = yield* Effect.promise(() => res.json());
    const emails = yield* decodeEmails(raw);
    if (emails.length < minimumCount) return yield* Effect.fail("waiting" as const);
    const latest = emails.at(-1);
    if (latest === undefined || !latest.body.subject.includes(expectedSubjectFragment)) {
      return yield* Effect.fail("waiting" as const);
    }
    const match = /\b([0-9]{6})\b/u.exec(latest.body.text);
    const code = match?.[1];
    if (code === undefined) return yield* Effect.fail("waiting" as const);
    return code;
  });
  return yield* readOnce.pipe(
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(100)), times: 80 }),
  );
});

let ownerPasskey: VirtualPasskey | undefined;
let ownerCookie = "";

describe("first-run passkey setup", () => {
  // The tests in this file share one database and run sequentially.
  it.effect("reports setup state, Email OTP availability, and recovery availability", () =>
    Effect.gen(function* () {
      const main = yield* authStatus(env.TEST_WORKER);
      assert.deepEqual(main, {
        setupState: "open",
        emailOtpEnabled: true,
        recoveryEnabled: true,
      });

      const keyless = yield* authStatus(env.KEYLESS_WORKER);
      assert.deepEqual(keyless, {
        setupState: "open",
        emailOtpEnabled: false,
        recoveryEnabled: false,
      });

      const derived = yield* authStatus(env.DERIVED_ORIGIN_WORKER);
      assert.deepEqual(derived, {
        setupState: "token-missing",
        emailOtpEnabled: false,
        recoveryEnabled: false,
      });

      const refused = yield* postJson(
        env.DERIVED_ORIGIN_WORKER,
        "https://forms.example.test/api/setup/options",
        owner,
        { authorization: "Bearer anything" },
      );
      assert.strictEqual(refused.status, 404);
    }),
  );

  it.live("limits the setup tokens that one client tries in a minute", () =>
    Effect.gen(function* () {
      const attempts = yield* Effect.forEach(Array.from({ length: 11 }), () =>
        requestSetupOptions("a wrong token that is long enough to be a guess", "198.51.100.7"),
      );
      const statuses = attempts.map(({ status }) => status);
      assert.isTrue(statuses.includes(429), statuses.join(", "));
      assert.deepEqual(
        statuses.filter((status) => status !== 429),
        statuses.filter((status) => status === 404),
      );
      const status = yield* authStatus(env.TEST_WORKER);
      assert.strictEqual(status.setupState, "open");
    }),
  );

  it.effect("refuses an oversized body on setup", () =>
    Effect.gen(function* () {
      const response = yield* postJson(
        env.TEST_WORKER,
        `${testOrigin}/api/setup/options`,
        { ...owner, name: "a".repeat(9_000) },
        { authorization: `Bearer ${testSetupToken}`, "cf-connecting-ip": "198.51.100.12" },
      );
      assert.strictEqual(response.status, 413);
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
    }),
  );

  it.effect("leaves no user row if passkey registration is cancelled before verify", () =>
    Effect.gen(function* () {
      const optionsResponse = yield* requestSetupOptions(testSetupToken, "198.51.100.13");
      assert.strictEqual(optionsResponse.status, 200);
      const users = yield* Effect.promise(() =>
        env.DB.prepare("SELECT count(*) AS total FROM auth_users").first("total"),
      );
      assert.strictEqual(users, 0);
      const status = yield* authStatus(env.TEST_WORKER);
      assert.strictEqual(status.setupState, "open");
    }),
  );

  it.effect("creates the owner atomically with a passkey, sets a session cookie, and closes", () =>
    Effect.gen(function* () {
      const optionsResponse = yield* requestSetupOptions(testSetupToken, "198.51.100.8");
      assert.strictEqual(optionsResponse.status, 200);
      const creationOptions = yield* Effect.promise(() => optionsResponse.json()).pipe(
        Effect.flatMap(decodeCreationOptions),
      );
      const { passkey, credential } = yield* Effect.promise(() =>
        registerVirtualPasskey(creationOptions, testOrigin),
      );
      ownerPasskey = passkey;

      const verified = yield* postJson(
        env.TEST_WORKER,
        `${testOrigin}/api/setup/verify`,
        { credential, passkeyName: "Primary laptop" },
        { authorization: `Bearer ${testSetupToken}`, "cf-connecting-ip": "198.51.100.8" },
      );
      assert.strictEqual(verified.status, 201);
      const setCookie =
        verified.headers
          .getSetCookie()
          .find((value) => value.startsWith("__Host-rondyr_session=")) ?? "";
      assert.match(setCookie, /; Secure/iu);
      assert.match(setCookie, /; HttpOnly/iu);
      assert.match(setCookie, /; SameSite=Lax/iu);
      assert.notMatch(setCookie, /; Domain=/iu);
      ownerCookie = cookieOf(verified);

      const main = yield* authStatus(env.TEST_WORKER);
      assert.strictEqual(main.setupState, "closed");
      const derived = yield* authStatus(env.DERIVED_ORIGIN_WORKER);
      assert.strictEqual(derived.setupState, "closed");

      const again = yield* requestSetupOptions(testSetupToken, "198.51.100.9");
      assert.strictEqual(again.status, 404);

      const creation = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch(`${testOrigin}/api/organization-creation`, {
          headers: { cookie: ownerCookie, origin: testOrigin },
        }),
      );
      assert.strictEqual(creation.status, 200);
      const creationBody = yield* Effect.promise(() => creation.json());
      assert.deepEqual(creationBody, { allowed: true });
    }),
  );
});

describe("passkey sign-in security", () => {
  it.effect(
    "signs in with discoverable credentials, updates counter and last_used_at, and rejects replays or tampering",
    () =>
      Effect.gen(function* () {
        if (ownerPasskey === undefined) return assert.fail("Expected owner passkey");
        const optionsResponse = yield* postJson(
          env.TEST_WORKER,
          `${testOrigin}/api/auth/passkey/options`,
          {},
        );
        assert.strictEqual(optionsResponse.status, 200);
        const options = yield* Effect.promise(() => optionsResponse.json()).pipe(
          Effect.flatMap(decodeRequestOptions),
        );
        assert.deepEqual(options.allowCredentials, []);

        const assertion = yield* Effect.promise(() =>
          assertVirtualPasskey(ownerPasskey!, options, testOrigin),
        );
        const signedIn = yield* postJson(env.TEST_WORKER, `${testOrigin}/api/auth/passkey/verify`, {
          credential: assertion,
        });
        assert.strictEqual(signedIn.status, 200);

        // Replaying the same assertion/challenge fails immediately.
        const replay = yield* postJson(env.TEST_WORKER, `${testOrigin}/api/auth/passkey/verify`, {
          credential: assertion,
        });
        assert.strictEqual(replay.status, 401);

        // Verify counter and last_used_at updated in D1.
        const row = yield* Effect.promise(() =>
          env.DB.prepare("SELECT counter, last_used_at FROM auth_passkeys WHERE credential_id = ?")
            .bind(ownerPasskey!.credentialId)
            .first<{ counter: number; last_used_at: number | null }>(),
        );
        assert.strictEqual(row?.counter, 1);
        assert.isNotNull(row?.last_used_at);

        // Wrong origin, wrong rpId, tampered signature, and non-advancing counter are all rejected.
        for (const badOverrides of [
          { origin: "https://attacker.example", counter: 2 },
          { rpId: "attacker.example", counter: 3 },
          { tamperSignature: true, counter: 4 },
          { counter: 1 },
        ]) {
          const freshOptions = yield* postJson(
            env.TEST_WORKER,
            `${testOrigin}/api/auth/passkey/options`,
            {},
          ).pipe(
            Effect.flatMap((res) => Effect.promise(() => res.json())),
            Effect.flatMap(decodeRequestOptions),
          );
          const bad = yield* Effect.promise(() =>
            assertVirtualPasskey(ownerPasskey!, freshOptions, testOrigin, badOverrides),
          );
          const rejected = yield* postJson(
            env.TEST_WORKER,
            `${testOrigin}/api/auth/passkey/verify`,
            { credential: bad },
          );
          assert.strictEqual(rejected.status, 401);
        }
      }),
  );
});

describe("Email OTP sign-in", () => {
  it.live("hides Email OTP and returns 503 when no email provider is configured", () =>
    Effect.gen(function* () {
      const req = yield* postJson(env.KEYLESS_WORKER, `${testOrigin}/api/auth/otp/request`, {
        email: owner.email,
      });
      const ver = yield* postJson(env.KEYLESS_WORKER, `${testOrigin}/api/auth/otp/verify`, {
        email: owner.email,
        code: "123456",
      });
      assert.strictEqual(req.status, 503);
      assert.strictEqual(ver.status, 503);
      const reqBody = yield* Effect.promise(() => req.json());
      const verBody = yield* Effect.promise(() => ver.json());
      assert.deepEqual(reqBody, { error: "email-provider-missing" });
      assert.deepEqual(verBody, { error: "email-provider-missing" });
    }),
  );

  it.live(
    "returns 202 for unknown emails without sign-up, enforces 5-attempt lockout, and signs in with a valid code",
    () =>
      Effect.gen(function* () {
        const unknown = yield* postJson(env.TEST_WORKER, `${testOrigin}/api/auth/otp/request`, {
          email: "stranger@example.test",
        });
        assert.strictEqual(unknown.status, 202);
        const strangerCount = yield* Effect.promise(() =>
          env.DB.prepare("SELECT count(*) AS total FROM auth_users WHERE email = ?")
            .bind("stranger@example.test")
            .first("total"),
        );
        assert.strictEqual(strangerCount, 0);

        const requested = yield* postJson(env.TEST_WORKER, `${testOrigin}/api/auth/otp/request`, {
          email: owner.email,
          language: "fr",
        });
        assert.strictEqual(requested.status, 202);

        const firstCode = yield* waitForOtpEmail(owner.email, 1, "code de connexion");

        // Five wrong guesses invalidate the code even if the right code is tried on attempt 6.
        const wrongCode = firstCode === "000000" ? "111111" : "000000";
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const bad = yield* postJson(env.TEST_WORKER, `${testOrigin}/api/auth/otp/verify`, {
            email: owner.email,
            code: wrongCode,
          });
          assert.strictEqual(bad.status, 401);
        }
        const lockedOut = yield* postJson(env.TEST_WORKER, `${testOrigin}/api/auth/otp/verify`, {
          email: owner.email,
          code: firstCode,
        });
        assert.strictEqual(lockedOut.status, 401);

        // Request a fresh code in English and sign in successfully.
        const secondRequest = yield* postJson(
          env.TEST_WORKER,
          `${testOrigin}/api/auth/otp/request`,
          { email: owner.email, language: "en" },
        );
        assert.strictEqual(secondRequest.status, 202);
        const secondCode = yield* waitForOtpEmail(owner.email, 2, "sign-in code");

        const verified = yield* postJson(env.TEST_WORKER, `${testOrigin}/api/auth/otp/verify`, {
          email: owner.email,
          code: secondCode,
        });
        assert.strictEqual(verified.status, 200);
        const otpCookie = cookieOf(verified);
        assert.isNotEmpty(otpCookie);

        // Replaying the consumed code fails.
        const replayed = yield* postJson(env.TEST_WORKER, `${testOrigin}/api/auth/otp/verify`, {
          email: owner.email,
          code: secondCode,
        });
        assert.strictEqual(replayed.status, 401);
      }),
  );
});

describe("recovery token and custom-domain migration", () => {
  it.live(
    "enforces rate limit and token check, then registers a new passkey and starts a session",
    () =>
      Effect.gen(function* () {
        // Disabled on workers without RONDYR_RECOVERY_TOKEN.
        const disabled = yield* postJson(
          env.KEYLESS_WORKER,
          `${testOrigin}/api/auth/recovery/options`,
          { email: owner.email },
          { authorization: `Bearer ${testRecoveryToken}` },
        );
        assert.strictEqual(disabled.status, 404);

        // Rate limit 5/min and no enumeration before token check.
        const guesses = yield* Effect.forEach(Array.from({ length: 11 }), () =>
          postJson(
            env.TEST_WORKER,
            `${testOrigin}/api/auth/recovery/options`,
            { email: owner.email },
            {
              authorization: "Bearer wrong-recovery-token-that-is-over-32-chars",
              "cf-connecting-ip": "198.51.100.31",
            },
          ),
        );
        assert.isTrue(guesses.some(({ status }) => status === 429));

        // Valid token + existing email registers a new passkey and signs in immediately.
        const optionsResponse = yield* postJson(
          env.TEST_WORKER,
          `${testOrigin}/api/auth/recovery/options`,
          { email: owner.email },
          { authorization: `Bearer ${testRecoveryToken}`, "cf-connecting-ip": "198.51.100.32" },
        );
        assert.strictEqual(optionsResponse.status, 200);
        const creationOptions = yield* Effect.promise(() => optionsResponse.json()).pipe(
          Effect.flatMap(decodeCreationOptions),
        );
        assert.lengthOf(creationOptions.excludeCredentials ?? [], 1);

        const { passkey: recoveredKey, credential } = yield* Effect.promise(() =>
          registerVirtualPasskey(creationOptions, testOrigin),
        );
        const recovered = yield* postJson(
          env.TEST_WORKER,
          `${testOrigin}/api/auth/recovery/verify`,
          { credential, passkeyName: "Recovered key" },
          { authorization: `Bearer ${testRecoveryToken}`, "cf-connecting-ip": "198.51.100.32" },
        );
        assert.strictEqual(recovered.status, 201);
        const recoveredCookie = cookieOf(recovered);
        assert.isNotEmpty(recoveredCookie);

        // The recovered passkey can now sign in normally.
        const signInOpts = yield* postJson(
          env.TEST_WORKER,
          `${testOrigin}/api/auth/passkey/options`,
          {},
        ).pipe(
          Effect.flatMap((res) => Effect.promise(() => res.json())),
          Effect.flatMap(decodeRequestOptions),
        );
        const assertion = yield* Effect.promise(() =>
          assertVirtualPasskey(recoveredKey, signInOpts, testOrigin),
        );
        const signedIn = yield* postJson(env.TEST_WORKER, `${testOrigin}/api/auth/passkey/verify`, {
          credential: assertion,
        });
        assert.strictEqual(signedIn.status, 200);
      }),
  );
});

describe("account passkey management", () => {
  it.effect(
    "lists, adds, renames, and deletes passkeys, refusing to delete the last passkey when Email OTP is unavailable",
    () =>
      Effect.gen(function* () {
        const headers = { cookie: ownerCookie, origin: testOrigin };
        const initial = yield* Effect.promise(() =>
          env.TEST_WORKER.fetch(`${testOrigin}/api/account/passkeys`, { headers }),
        ).pipe(
          Effect.flatMap((res) => {
            assert.strictEqual(res.status, 200);
            return Effect.promise(() => res.json());
          }),
          Effect.flatMap(decodeAccountPasskeys),
        );
        assert.strictEqual(initial.emailOtpEnabled, true);
        assert.lengthOf(initial.passkeys, 2);
        assert.isTrue(initial.passkeys.every((item) => item.currentDomain));

        // Add a third passkey.
        const addOpts = yield* postJson(
          env.TEST_WORKER,
          `${testOrigin}/api/account/passkeys/options`,
          {},
          headers,
        ).pipe(
          Effect.flatMap((res) => {
            assert.strictEqual(res.status, 200);
            return Effect.promise(() => res.json());
          }),
          Effect.flatMap(decodeCreationOptions),
        );
        assert.lengthOf(addOpts.excludeCredentials ?? [], 2);
        const { credential } = yield* Effect.promise(() =>
          registerVirtualPasskey(addOpts, testOrigin),
        );
        const addedResponse = yield* postJson(
          env.TEST_WORKER,
          `${testOrigin}/api/account/passkeys/verify`,
          { credential, name: "Hardware key" },
          headers,
        );
        assert.strictEqual(addedResponse.status, 201);
        const added = yield* Effect.promise(() => addedResponse.json()).pipe(
          Effect.flatMap(decodePasskeySummary),
        );
        assert.strictEqual(added.name, "Hardware key");

        // Rename it.
        const renameBody = yield* encodeJson({ name: "YubiKey 5" });
        const renamedResponse = yield* Effect.promise(() =>
          env.TEST_WORKER.fetch(`${testOrigin}/api/account/passkeys/${added.id}`, {
            method: "PATCH",
            headers: { ...headers, "content-type": "application/json" },
            body: renameBody,
          }),
        );
        assert.strictEqual(renamedResponse.status, 200);
        const renamed = yield* Effect.promise(() => renamedResponse.json()).pipe(
          Effect.flatMap(decodePasskeySummary),
        );
        assert.strictEqual(renamed.name, "YubiKey 5");

        // Delete two passkeys down to 1, then verify KEYLESS_WORKER (no Email OTP) refuses deleting the last one.
        for (const id of [added.id, initial.passkeys[0]!.id]) {
          const del = yield* Effect.promise(() =>
            env.TEST_WORKER.fetch(`${testOrigin}/api/account/passkeys/${id}`, {
              method: "DELETE",
              headers,
            }),
          );
          assert.strictEqual(del.status, 204);
        }
        const remainingId = initial.passkeys[1]!.id;
        const refusedLast = yield* Effect.promise(() =>
          env.KEYLESS_WORKER.fetch(`${testOrigin}/api/account/passkeys/${remainingId}`, {
            method: "DELETE",
            headers,
          }),
        );
        assert.strictEqual(refusedLast.status, 409);
        const refusedBody = yield* Effect.promise(() => refusedLast.json());
        assert.deepEqual(refusedBody, { error: "last-passkey" });
      }),
  );
});

describe("origin without RONDYR_PUBLIC_URL and legacy BETTER_AUTH_SECRET fallback", () => {
  it.effect(
    "signs in on a derived HTTPS origin and refuses cross-site, HTTP, custom port, and oversized bodies",
    () =>
      Effect.gen(function* () {
        const derivedOrigin = "https://forms.example.test";
        const optsRes = yield* postJson(
          env.DERIVED_ORIGIN_WORKER,
          `${derivedOrigin}/api/auth/passkey/options`,
          {},
        );
        assert.strictEqual(optsRes.status, 200);
        const opts = yield* Effect.promise(() => optsRes.json()).pipe(
          Effect.flatMap(decodeRequestOptions),
        );
        assert.strictEqual(opts.rpId, "forms.example.test");

        const crossSite = yield* postJson(
          env.DERIVED_ORIGIN_WORKER,
          `${derivedOrigin}/api/auth/passkey/options`,
          {},
          { origin: "https://attacker.example" },
        );
        assert.strictEqual(crossSite.status, 403);

        const plainHttp = yield* postJson(
          env.DERIVED_ORIGIN_WORKER,
          "http://forms.example.test/api/auth/passkey/options",
          {},
        );
        assert.strictEqual(plainHttp.status, 503);

        const customPort = yield* postJson(
          env.DERIVED_ORIGIN_WORKER,
          "https://forms.example.test:8443/api/auth/passkey/options",
          {},
        );
        assert.strictEqual(customPort.status, 503);

        const oversized = yield* postJson(
          env.DERIVED_ORIGIN_WORKER,
          `${derivedOrigin}/api/auth/sign-out`,
          { pad: "p".repeat(9_000) },
        );
        assert.strictEqual(oversized.status, 413);

        const anonSession = yield* Effect.promise(() =>
          env.DERIVED_ORIGIN_WORKER.fetch(`${derivedOrigin}/api/auth/get-session`),
        );
        assert.strictEqual(anonSession.status, 200);
        const anonBody = yield* Effect.promise(() => anonSession.json());
        assert.isNull(anonBody);

        const activeSession = yield* Effect.promise(() =>
          env.TEST_WORKER.fetch(`${testOrigin}/api/auth/get-session`, {
            headers: { cookie: ownerCookie },
          }),
        );
        assert.strictEqual(activeSession.status, 200);
        const parsed = yield* Effect.promise(() => activeSession.json()).pipe(
          Effect.flatMap(decodeSession),
        );
        assert.strictEqual(parsed.user.email, owner.email);
      }),
  );
});
