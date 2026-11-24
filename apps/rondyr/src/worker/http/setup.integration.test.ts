import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin, testSetupToken } from "../../../tests/integration/auth-fixture.ts";
import { SetupStatus } from "../../domain/organizations/setup.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeStatus = Schema.decodeUnknownEffect(SetupStatus);
const decodeSession = Schema.decodeUnknownEffect(
  Schema.Struct({ user: Schema.Struct({ email: Schema.String }) }),
);
const owner = {
  name: "Instance owner",
  email: "instance-owner@example.test",
  password: "the owner password of a new instance",
};

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const setupState = Effect.fnUntraced(function* (worker: Fetcher) {
  const response = yield* Effect.promise(() => worker.fetch(`${testOrigin}/api/setup`));
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  const body = yield* Effect.promise(() => response.json());
  return (yield* decodeStatus(body)).state;
});

const claim = Effect.fnUntraced(function* (token: string, client: string) {
  const body = yield* encodeJson(owner);
  return yield* Effect.promise(() =>
    env.TEST_WORKER.fetch(`${testOrigin}/api/setup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "cf-connecting-ip": client,
        origin: testOrigin,
      },
      body,
    }),
  );
});

/** A request to the Worker without BETTER_AUTH_URL, from the origin of `url`. */
const derived = Effect.fnUntraced(function* (url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("origin")) headers.set("origin", new URL(url).origin);
  return yield* Effect.promise(() => env.DERIVED_ORIGIN_WORKER.fetch(url, { ...init, headers }));
});

describe("first-run setup", () => {
  // The tests of this file share one database, so they run in order: unclaimed, then claimed.
  it.effect("tells an unclaimed instance whether its setup token is ready", () =>
    Effect.gen(function* () {
      const withToken = yield* setupState(env.TEST_WORKER);
      assert.strictEqual(withToken, "open");
      // The Worker without RONDYR_SETUP_TOKEN cannot be claimed at all.
      const withoutToken = yield* setupState(env.DERIVED_ORIGIN_WORKER);
      assert.strictEqual(withoutToken, "token-missing");
      const body = yield* encodeJson(owner);
      const refused = yield* derived("https://forms.example.test/api/setup", {
        method: "POST",
        headers: { authorization: "Bearer anything", "content-type": "application/json" },
        body,
      });
      assert.strictEqual(refused.status, 404);
    }),
  );

  it.live("limits the setup tokens that one client tries in a minute", () =>
    Effect.gen(function* () {
      // The binding counts in fixed windows of the wall clock. Twice the limit plus one
      // attempt fill at least one window past the limit, even if a window ends meanwhile.
      const attempts = yield* Effect.forEach(Array.from({ length: 11 }), () =>
        claim("a wrong token that is long enough to be a guess", "198.51.100.7"),
      );
      const statuses = attempts.map(({ status }) => status);
      assert.isTrue(statuses.includes(429), statuses.join(", "));
      assert.deepEqual(
        statuses.filter((status) => status !== 429),
        statuses.filter((status) => status === 404),
      );
      const state = yield* setupState(env.TEST_WORKER);
      assert.strictEqual(state, "open");
    }),
  );

  it.effect("creates the owner with the setup token, then closes", () =>
    Effect.gen(function* () {
      const created = yield* claim(testSetupToken, "198.51.100.8");
      assert.strictEqual(created.status, 201);
      const withToken = yield* setupState(env.TEST_WORKER);
      assert.strictEqual(withToken, "closed");
      // Once an account exists, the answer no longer says anything about the token.
      const withoutToken = yield* setupState(env.DERIVED_ORIGIN_WORKER);
      assert.strictEqual(withoutToken, "closed");
      const again = yield* claim(testSetupToken, "198.51.100.9");
      assert.strictEqual(again.status, 404);
    }),
  );
});

describe("origin without BETTER_AUTH_URL", () => {
  const credentials = { email: owner.email, password: owner.password };

  it.effect("signs in on the HTTPS origin of the request", () =>
    Effect.gen(function* () {
      const body = yield* encodeJson(credentials);
      const signIn = yield* derived("https://forms.example.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.strictEqual(signIn.status, 200);
      const cookie =
        signIn.headers
          .getSetCookie()
          .find((value) => value.startsWith("__Secure-better-auth.session_token=")) ?? "";
      assert.match(cookie, /; Secure/iu);
      assert.match(cookie, /; HttpOnly/iu);
      assert.notMatch(cookie, /; Domain=/iu);

      const session = yield* derived("https://forms.example.test/api/auth/get-session", {
        headers: { cookie: cookie.split(";")[0] ?? "" },
      });
      const sessionBody = yield* Effect.promise(() => session.json());
      const { user } = yield* decodeSession(sessionBody);
      assert.strictEqual(user.email, owner.email);
    }),
  );

  it.effect("refuses another site, plain HTTP and a custom port", () =>
    Effect.gen(function* () {
      const body = yield* encodeJson(credentials);
      const signIn = (url: string, origin = new URL(url).origin) =>
        derived(url, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body,
        });
      const crossSite = yield* signIn(
        "https://forms.example.test/api/auth/sign-in/email",
        "https://attacker.example",
      );
      assert.strictEqual(crossSite.status, 403);
      const plainHttp = yield* signIn("http://forms.example.test/api/auth/sign-in/email");
      assert.strictEqual(plainHttp.status, 503);
      const customPort = yield* signIn("https://forms.example.test:8443/api/auth/sign-in/email");
      assert.strictEqual(customPort.status, 503);
    }),
  );
});
