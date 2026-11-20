import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Exit, Schema } from "effect";
import { assert, beforeAll, describe, it } from "@effect/vitest";

import { testOrigin as origin, testSetupToken } from "../tests/integration/auth-fixture.ts";
import { forms, organizations } from "./adapters/database/database-schema.ts";

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

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

describe("Rondyr Worker", () => {
  it.effect("answers the public health check without caching it", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch("https://rondyr.test/health"),
      );
      const body = yield* Effect.promise(() => response.json());

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(body, { status: "ok" });
    }),
  );

  it.effect("forbids MIME sniffing on every Worker response", () =>
    Effect.gen(function* () {
      const responses = yield* Effect.all([
        Effect.promise(() => env.TEST_WORKER.fetch(`${origin}/health`)),
        Effect.promise(() => env.TEST_WORKER.fetch(`${origin}/api/missing`)),
        Effect.promise(() => env.TEST_WORKER.fetch(`${origin}/api/auth/get-session`)),
        Effect.promise(() =>
          env.TEST_WORKER.fetch(`${origin}/f/unknown`, {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: "message",
          }),
        ),
      ]);

      assert.deepEqual(
        responses.map(({ status }) => status),
        [200, 404, 200, 415],
      );
      for (const response of responses) {
        assert.strictEqual(response.headers.get("x-content-type-options"), "nosniff");
      }
    }),
  );

  it.effect("returns 404 for a missing API route", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch("https://rondyr.test/api/missing"),
      );

      assert.strictEqual(response.status, 404);
    }),
  );

  it.effect("applies the committed migration and writes a form in D1 with Drizzle", () =>
    Effect.gen(function* () {
      const db = drizzle(env.DB);

      yield* Effect.promise(() =>
        db.insert(organizations).values({ id: "test-org", name: "Test organization" }).run(),
      );
      yield* Effect.promise(() =>
        db
          .insert(forms)
          .values({
            id: "test-form",
            organizationId: "test-org",
            publicId: "contact",
            name: "Contact",
          })
          .run(),
      );
      const rows = yield* Effect.promise(() => db.select().from(forms).all());

      assert.deepEqual(rows, [
        {
          id: "test-form",
          organizationId: "test-org",
          publicId: "contact",
          name: "Contact",
          businessContext: null,
          status: "active",
          successUrl: null,
        },
      ]);

      const missingId = yield* Effect.exit(
        Effect.promise(() =>
          env.DB.prepare("INSERT INTO organizations (name) VALUES (?)").bind("Missing ID").run(),
        ),
      );
      assert.isTrue(Exit.isFailure(missingId));
    }),
  );
});

describe("Rondyr authentication", () => {
  it.effect("creates one operator, rejects cross-origin sign-in and manages the session", () =>
    Effect.gen(function* () {
      const details = yield* encodeJson(owner);

      const publicRegistration = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch(post("/api/auth/sign-up/email", details)),
      );
      const unauthenticatedSetup = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch(post("/api/setup", details)),
      );
      assert.strictEqual(publicRegistration.status, 404);
      assert.strictEqual(unauthenticatedSetup.status, 404);

      const setupHeader = { authorization: `Bearer ${testSetupToken}` };
      const invalidEmail = yield* encodeJson({ ...owner, email: "..owner@example.test" });
      const invalidSetup = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch(post("/api/setup", invalidEmail, setupHeader)),
      );
      assert.strictEqual(invalidSetup.status, 400);

      const install = () =>
        Effect.promise(() => env.TEST_WORKER.fetch(post("/api/setup", details, setupHeader)));
      const [first, second] = yield* Effect.all([install(), install()], {
        concurrency: "unbounded",
      });
      assert.deepEqual([first.status, second.status].toSorted(), [201, 404]);
      const afterSetup = yield* install();
      assert.strictEqual(afterSetup.status, 404);

      const credentials = yield* encodeJson({ email: owner.email, password: owner.password });
      const crossOrigin = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch(
          post("/api/auth/sign-in/email", credentials, { origin: "https://other.test" }),
        ),
      );
      assert.strictEqual(crossOrigin.status, 403);

      const login = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch(post("/api/auth/sign-in/email", credentials)),
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
        env.TEST_WORKER.fetch(
          new Request(`${origin}/api/auth/get-session`, { headers: sessionHeaders }),
        ),
      );
      const sessionBody = yield* Effect.promise(() => session.json());
      const signedIn = yield* Schema.decodeUnknownEffect(SessionUser)(sessionBody);
      assert.strictEqual(signedIn.user.email, owner.email);

      const logout = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch(post("/api/auth/sign-out", "{}", sessionHeaders)),
      );
      assert.strictEqual(logout.status, 200);
      const revokedSession = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch(
          new Request(`${origin}/api/auth/get-session`, { headers: sessionHeaders }),
        ),
      );
      const revokedBody = yield* Effect.promise(() => revokedSession.json());
      assert.isNull(revokedBody);
    }),
  );
});
