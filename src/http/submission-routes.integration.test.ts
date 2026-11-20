import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";

import { testOrigin as origin } from "../../tests/integration/auth-fixture.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const seedForm = (name: string) =>
  Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(
        `${name}-org`,
        name,
      ),
      env.DB.prepare(
        "INSERT INTO forms (id, organization_id, public_id, name) VALUES (?, ?, ?, ?)",
      ).bind(`${name}-form`, `${name}-org`, name, name),
    ]),
  );

const expectStored = Effect.fnUntraced(function* (name: string, expected: number) {
  const count = yield* Effect.promise(() =>
    env.DB.prepare("SELECT COUNT(*) AS count FROM submissions WHERE form_id = ?")
      .bind(`${name}-form`)
      .first("count"),
  );
  assert.strictEqual(count, expected);
});

const submit = (name: string, contentType: string | null, body: BodyInit) =>
  Effect.promise(() =>
    env.TEST_WORKER.fetch(new URL(`/f/${name}`, origin), {
      method: "POST",
      headers: contentType === null ? {} : { "content-type": contentType },
      body,
    }),
  );

/** An `application/x-www-form-urlencoded` body of exactly `bytes` ASCII bytes. */
function urlEncodedBody(bytes: number) {
  // Five fields: "f1=" to "f5=" and four "&" separators take 19 bytes.
  const values = bytes - 19;
  const size = Math.floor(values / 5);
  const sizes = [size, size, size, size, values - 4 * size];
  return sizes.map((length, index) => `f${index + 1}=${"x".repeat(length)}`).join("&");
}

it.live("answers 415 to a body that is neither JSON nor URL-encoded", () =>
  Effect.gen(function* () {
    yield* seedForm("intake-media");
    const responses = yield* Effect.all([
      submit("intake-media", "text/plain", "message=hello"),
      submit("intake-media", "multipart/form-data; boundary=x", "--x--"),
      // A byte body gets no default content type, unlike a string body.
      submit("intake-media", null, new TextEncoder().encode('{"message":"hello"}')),
    ]);

    assert.deepEqual(
      responses.map(({ status }) => status),
      [415, 415, 415],
    );
    for (const response of responses) {
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
    }
    yield* expectStored("intake-media", 0);
  }),
);

it.live("answers 400 to invalid fields and stores nothing", () =>
  Effect.gen(function* () {
    yield* seedForm("intake-fields");
    const json = "application/json";
    const form = "application/x-www-form-urlencoded";
    const tooMany = yield* encode(
      Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`f${index}`, "x"])),
    );
    const longValue = yield* encode({ message: "x".repeat(4001) });
    const longName = yield* encode({ ["n".repeat(101)]: "hello" });
    const responses = yield* Effect.all([
      submit("intake-fields", json, '{"message":'),
      submit("intake-fields", json, '["hello"]'),
      submit("intake-fields", json, "{}"),
      submit("intake-fields", json, '{"message":{"text":"hello"}}'),
      submit("intake-fields", json, '{"message":42}'),
      submit("intake-fields", json, '{"__proto__":"hello"}'),
      submit("intake-fields", json, tooMany),
      submit("intake-fields", json, longValue),
      submit("intake-fields", json, longName),
      submit("intake-fields", form, "message=hello&message=again"),
      submit("intake-fields", form, ""),
    ]);

    assert.deepEqual(
      responses.map(({ status }) => status),
      Array.from({ length: 11 }, () => 400),
    );
    yield* expectStored("intake-fields", 0);
  }),
);

it.live("answers 413 above 16 KiB and accepts a body of exactly 16 KiB", () =>
  Effect.gen(function* () {
    yield* seedForm("intake-size");
    const form = "application/x-www-form-urlencoded";
    const tooLarge = yield* submit("intake-size", form, urlEncodedBody(16 * 1024 + 1));
    const json = yield* encode(
      Object.fromEntries(["a", "b", "c", "d", "e"].map((name) => [name, "x".repeat(3300)])),
    );
    const largeJson = yield* submit("intake-size", "application/json", json);
    assert.strictEqual(tooLarge.status, 413);
    assert.strictEqual(largeJson.status, 413);
    yield* expectStored("intake-size", 0);

    const atLimit = yield* submit("intake-size", form, urlEncodedBody(16 * 1024));
    assert.strictEqual(atLimit.status, 202);
    yield* expectStored("intake-size", 1);
  }),
);

it.live("answers 429 after 30 submissions in a minute on one form", () =>
  Effect.gen(function* () {
    yield* seedForm("intake-rate");
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() =>
      env.DB.batch(
        Array.from({ length: 29 }, (_, index) =>
          env.DB.prepare(
            "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, ?)",
          ).bind(
            `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            "intake-rate-org",
            "intake-rate-form",
            '{"message":"earlier"}',
            now,
          ),
        ),
      ),
    );

    const body = '{"message":"hello"}';
    const thirtieth = yield* submit("intake-rate", "application/json", body);
    assert.strictEqual(thirtieth.status, 202);
    const limited = yield* submit("intake-rate", "application/json", body);
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.headers.get("retry-after"), "60");
    assert.strictEqual(limited.headers.get("cache-control"), "no-store");
    yield* expectStored("intake-rate", 30);
  }),
);
