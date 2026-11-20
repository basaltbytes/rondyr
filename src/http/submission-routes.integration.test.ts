import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { testOrigin as origin } from "../../tests/integration/auth-fixture.ts";
import { outboxLive } from "../adapters/database/outbox.ts";
import { classificationQueueLive } from "../adapters/queues/classification-queue.ts";
import { BackgroundTasks } from "../ports/background-tasks.ts";
import { SubmissionIntake } from "../ports/intake.ts";
import { StorageUnavailable } from "../ports/storage.ts";
import { submissionRoutes } from "./submission-routes.ts";

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

const shop = "https://shop.example.com";
const elsewhere = "https://elsewhere.example.com";
const contact = '{"email":"visitor@example.com","message":"Is there room in the pottery class?"}';

const seedOrigins = (name: string, origins: ReadonlyArray<string>) =>
  Effect.promise(() =>
    env.DB.batch(
      origins.map((value) =>
        env.DB.prepare(
          "INSERT INTO form_origins (form_id, origin, created_at) VALUES (?, ?, 0)",
        ).bind(`${name}-form`, value),
      ),
    ),
  );

const send = (name: string, init: RequestInit) =>
  Effect.promise(() => env.TEST_WORKER.fetch(new URL(`/f/${name}`, origin), init));

/** A preflight as a browser sends it before a `fetch` with a JSON body. */
const preflight = (name: string, from: string) =>
  send(name, {
    method: "OPTIONS",
    headers: {
      origin: from,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });

/** A `fetch` with a JSON body from a page on `from`, or from a client without `Origin`. */
function fetchJson(name: string, from: string | null, body = contact) {
  const headers = new Headers({ "content-type": "application/json" });
  if (from !== null) headers.set("origin", from);
  return send(name, { method: "POST", headers, body });
}

/** An HTML form posted from a page on `from`. */
const htmlPost = (name: string, from: string) =>
  send(name, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      origin: from,
    },
    body: "email=visitor%40example.com&message=Hello",
  });

const textPost = (name: string, from: string) =>
  send(name, {
    method: "POST",
    headers: { "content-type": "text/plain", origin: from },
    body: "message=hello",
  });

function cors(response: Response) {
  return {
    status: response.status,
    allowOrigin: response.headers.get("access-control-allow-origin"),
    vary: response.headers.get("vary"),
    credentials: response.headers.get("access-control-allow-credentials"),
  };
}

it.live("answers preflights according to the form's allowed origins", () =>
  Effect.gen(function* () {
    yield* seedForm("cors-open");
    yield* seedForm("cors-listed");
    yield* seedOrigins("cors-listed", [shop, "http://localhost:4321"]);
    const responses = yield* Effect.all([
      preflight("cors-open", elsewhere),
      preflight("cors-listed", shop),
      preflight("cors-listed", "http://localhost:4321"),
      preflight("cors-listed", elsewhere),
      preflight("cors-unknown", shop),
    ]);

    assert.deepEqual(responses.map(cors), [
      { status: 204, allowOrigin: "*", vary: null, credentials: null },
      { status: 204, allowOrigin: shop, vary: "Origin", credentials: null },
      { status: 204, allowOrigin: "http://localhost:4321", vary: "Origin", credentials: null },
      { status: 403, allowOrigin: null, vary: "Origin", credentials: null },
      { status: 404, allowOrigin: "*", vary: null, credentials: null },
    ]);
    for (const response of responses.slice(0, 3)) {
      assert.deepEqual(
        [
          response.headers.get("access-control-allow-methods"),
          response.headers.get("access-control-allow-headers"),
          response.headers.get("access-control-max-age"),
        ],
        ["POST", "content-type", "7200"],
      );
    }
    for (const response of responses) {
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
    }
  }),
);

it.live("accepts a JSON fetch from an allowed origin and refuses another origin", () =>
  Effect.gen(function* () {
    yield* seedForm("cors-fetch");
    yield* seedOrigins("cors-fetch", [shop]);
    const allowed = yield* fetchJson("cors-fetch", shop);
    assert.deepEqual(cors(allowed), {
      status: 202,
      allowOrigin: shop,
      vary: "Origin",
      credentials: null,
    });
    const body = yield* Effect.promise(() => allowed.json());
    assert.include(body, { status: "received" });
    yield* expectStored("cors-fetch", 1);

    // Refused before anything is stored, and the page cannot read the response.
    const refused = yield* fetchJson("cors-fetch", elsewhere);
    assert.deepEqual(cors(refused), {
      status: 403,
      allowOrigin: null,
      vary: "Origin",
      credentials: null,
    });
    const opaque = yield* fetchJson("cors-fetch", "null");
    assert.strictEqual(opaque.status, 403);
    yield* expectStored("cors-fetch", 1);

    // A client without Origin, such as curl or a server, is accepted whatever the list.
    const server = yield* fetchJson("cors-fetch", null);
    assert.deepEqual(cors(server), {
      status: 202,
      allowOrigin: null,
      vary: "Origin",
      credentials: null,
    });
    yield* expectStored("cors-fetch", 2);

    // A form without allowed origins accepts every origin.
    yield* seedForm("cors-anywhere");
    const anywhere = yield* fetchJson("cors-anywhere", elsewhere);
    assert.deepEqual(cors(anywhere), {
      status: 202,
      allowOrigin: "*",
      vary: null,
      credentials: null,
    });
    yield* expectStored("cors-anywhere", 1);
  }),
);

it.live("applies the allowed origins to an HTML form posted from another site", () =>
  Effect.gen(function* () {
    yield* seedForm("cors-html");
    yield* seedOrigins("cors-html", [shop]);
    const refused = yield* htmlPost("cors-html", elsewhere);
    assert.strictEqual(refused.status, 403);
    yield* expectStored("cors-html", 0);
    const allowed = yield* htmlPost("cors-html", shop);
    assert.strictEqual(allowed.status, 202);
    assert.strictEqual(allowed.headers.get("content-type"), "text/html; charset=utf-8");
    assert.strictEqual(allowed.headers.get("access-control-allow-origin"), shop);
    yield* expectStored("cors-html", 1);
  }),
);

it.live("sends the CORS headers with each error status of the intake", () =>
  Effect.gen(function* () {
    yield* seedForm("cors-errors");
    yield* seedOrigins("cors-errors", [shop]);
    const largeJson = yield* encode({ message: "x".repeat(17 * 1024) });
    const errors = yield* Effect.all([
      fetchJson("cors-errors", shop, '{"message":'),
      fetchJson("cors-errors", shop, largeJson),
      textPost("cors-errors", shop),
      fetchJson("cors-missing", shop),
      fetchJson("cors-missing", elsewhere, '{"message":'),
    ]);
    assert.deepEqual(errors.map(cors), [
      { status: 400, allowOrigin: shop, vary: "Origin", credentials: null },
      { status: 413, allowOrigin: shop, vary: "Origin", credentials: null },
      { status: 415, allowOrigin: shop, vary: "Origin", credentials: null },
      { status: 404, allowOrigin: "*", vary: null, credentials: null },
      { status: 400, allowOrigin: "*", vary: null, credentials: null },
    ]);

    // An invalid request from an origin that is not allowed keeps its status, without CORS headers.
    const refused = yield* Effect.all([
      fetchJson("cors-errors", elsewhere, '{"message":'),
      textPost("cors-errors", elsewhere),
    ]);
    assert.deepEqual(refused.map(cors), [
      { status: 400, allowOrigin: null, vary: "Origin", credentials: null },
      { status: 415, allowOrigin: null, vary: "Origin", credentials: null },
    ]);

    const now = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() =>
      env.DB.batch(
        Array.from({ length: 30 }, (_, index) =>
          env.DB.prepare(
            "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, ?)",
          ).bind(
            `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`,
            "cors-errors-org",
            "cors-errors-form",
            '{"message":"earlier"}',
            now,
          ),
        ),
      ),
    );
    const limited = yield* fetchJson("cors-errors", shop);
    assert.deepEqual(cors(limited), {
      status: 429,
      allowOrigin: shop,
      vary: "Origin",
      credentials: null,
    });
    assert.strictEqual(limited.headers.get("retry-after"), "60");
    assert.strictEqual(limited.headers.get("access-control-expose-headers"), "retry-after");
    // The origin is checked before the rate limit.
    const refusedWhileLimited = yield* fetchJson("cors-errors", elsewhere);
    assert.strictEqual(refusedWhileLimited.status, 403);
    yield* expectStored("cors-errors", 30);
  }),
);

it.live("sends the CORS headers with a 503 when D1 is unavailable", () =>
  Effect.gen(function* () {
    const unavailable = Layer.mergeAll(
      Layer.succeed(SubmissionIntake, {
        receive: () => Effect.fail(StorageUnavailable.make()),
        matchOrigin: () => Effect.fail(StorageUnavailable.make()),
      }),
      Layer.succeed(BackgroundTasks, { run: () => Effect.void }),
      // Never called: nothing is stored, so nothing is published.
      outboxLive,
      classificationQueueLive,
    );
    const services = yield* Layer.build(unavailable);
    const { handler, dispose } = HttpRouter.toWebHandler(
      submissionRoutes.pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );
    const call = (method: string, body: string | null) =>
      Effect.promise(() =>
        handler(
          new Request(new URL("/f/cors-down", origin), {
            method,
            headers: { "content-type": "application/json", origin: shop },
            body,
          }),
          services,
        ),
      );
    const responses = yield* Effect.all([call("POST", contact), call("OPTIONS", null)]);
    assert.deepEqual(responses.map(cors), [
      { status: 503, allowOrigin: "*", vary: null, credentials: null },
      { status: 503, allowOrigin: "*", vary: null, credentials: null },
    ]);
    yield* Effect.promise(dispose);
  }).pipe(Effect.scoped),
);
