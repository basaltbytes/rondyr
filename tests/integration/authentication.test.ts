import { applyD1Migrations } from "cloudflare:test";
import { env, exports as worker } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { assert, describe, it } from "@effect/vitest";

import { testOrigin as origin, testSetupToken } from "./auth-fixture.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const SessionUser = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });
const owner = {
  name: "Test Owner",
  email: "owner@example.test",
  password: "a test password for the isolated worker",
};

function post(path: string, body: string, headers?: HeadersInit) {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("cf-connecting-ip", "192.0.2.10");
  if (!requestHeaders.has("origin")) requestHeaders.set("origin", origin);
  return new Request(new URL(path, origin), { method: "POST", headers: requestHeaders, body });
}

describe("Rondyr authentication", () => {
  it.effect("creates one operator, rejects cross-origin sign-in and manages the session", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
      const details = yield* encodeJson(owner);

      const publicRegistration = yield* Effect.promise(() =>
        worker.default.fetch(post("/api/auth/sign-up/email", details)),
      );
      const unauthenticatedSetup = yield* Effect.promise(() =>
        worker.default.fetch(post("/api/setup", details)),
      );
      assert.strictEqual(publicRegistration.status, 404);
      assert.strictEqual(unauthenticatedSetup.status, 404);

      const setupHeader = { authorization: `Bearer ${testSetupToken}` };
      const invalidEmail = yield* encodeJson({ ...owner, email: "..owner@example.test" });
      const invalidSetup = yield* Effect.promise(() =>
        worker.default.fetch(post("/api/setup", invalidEmail, setupHeader)),
      );
      assert.strictEqual(invalidSetup.status, 400);

      const install = () =>
        Effect.promise(() => worker.default.fetch(post("/api/setup", details, setupHeader)));
      const [first, second] = yield* Effect.all([install(), install()], {
        concurrency: "unbounded",
      });
      assert.deepEqual([first.status, second.status].toSorted(), [201, 404]);
      const afterSetup = yield* install();
      assert.strictEqual(afterSetup.status, 404);

      const credentials = yield* encodeJson({ email: owner.email, password: owner.password });
      const crossOrigin = yield* Effect.promise(() =>
        worker.default.fetch(
          post("/api/auth/sign-in/email", credentials, { origin: "https://other.test" }),
        ),
      );
      assert.strictEqual(crossOrigin.status, 403);

      const login = yield* Effect.promise(() =>
        worker.default.fetch(post("/api/auth/sign-in/email", credentials)),
      );
      assert.strictEqual(login.status, 200);
      const cookie =
        login.headers
          .getSetCookie()
          .find((value) => value.startsWith("__Secure-better-auth.session_token=")) ?? "";
      assert.match(cookie, /; HttpOnly/i);
      assert.match(cookie, /; Secure/i);
      assert.match(cookie, /; SameSite=Lax/i);
      const sessionHeaders = { cookie: cookie.split(";")[0] ?? "" };

      const session = yield* Effect.promise(() =>
        worker.default.fetch(
          new Request(`${origin}/api/auth/get-session`, { headers: sessionHeaders }),
        ),
      );
      const sessionBody = yield* Effect.promise(() => session.json());
      const signedIn = yield* Schema.decodeUnknownEffect(SessionUser)(sessionBody);
      assert.strictEqual(signedIn.user.email, owner.email);

      const logout = yield* Effect.promise(() =>
        worker.default.fetch(post("/api/auth/sign-out", "{}", sessionHeaders)),
      );
      assert.strictEqual(logout.status, 200);
      const revokedSession = yield* Effect.promise(() =>
        worker.default.fetch(
          new Request(`${origin}/api/auth/get-session`, { headers: sessionHeaders }),
        ),
      );
      const revokedBody = yield* Effect.promise(() => revokedSession.json());
      assert.isNull(revokedBody);
    }),
  );
});
