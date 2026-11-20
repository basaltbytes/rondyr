import { applyD1Migrations } from "cloudflare:test";
import { env, withEnv } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { testOrigin as origin } from "../../tests/integration/auth-fixture.ts";
import wrangler from "../../wrangler.json" with { type: "json" };
import { submissionIntakeLive } from "../adapters/database/intake.ts";
import { outboxLive } from "../adapters/database/outbox.ts";
import { classificationQueueLive } from "../adapters/queues/classification-queue.ts";
import { BackgroundTasks } from "../ports/background-tasks.ts";
import { ClientRateLimit } from "../ports/client-rate-limit.ts";
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

it.live(
  "stores an admitted submission, its repetition facts and its outbox event in one D1 call",
  () =>
    Effect.gen(function* () {
      const publicId = "intake-repetition-round-trip";
      yield* seedForm(publicId);
      const db = env.DB;
      const batch = vi.fn(db.batch.bind(db));
      const prepare = vi.fn((sql: string) => {
        const statement = db.prepare(sql);
        const bind = statement.bind.bind(statement);
        vi.spyOn(statement, "bind").mockImplementation((...values) => {
          const bound = bind(...values);
          for (const method of ["all", "first", "raw", "run"] as const) {
            vi.spyOn(bound, method).mockImplementation(() => {
              assert.fail(`Intake sent a separate D1 call via ${method}`);
            });
          }
          return bound;
        });
        return statement;
      });
      const receive = SubmissionIntake.use((intake) =>
        intake.receive(
          publicId,
          { email: "roundtrip@example.test", message: "One D1 call" },
          Option.none(),
        ),
      );
      const services = yield* Layer.build(submissionIntakeLive);
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);
      yield* Effect.promise(() =>
        Promise.resolve(
          withEnv({ ...env, DB: { batch, prepare } }, () =>
            run(receive.pipe(Effect.provideContext(services))),
          ),
        ),
      );
      assert.strictEqual(batch.mock.calls.length, 1);
      const row = yield* Effect.promise(() =>
        db
          .prepare(`
      SELECT s.prior_same_sender, s.prior_same_content, o.submission_id = s.id AS has_outbox
      FROM submissions s JOIN outbox_events o ON o.submission_id = s.id
      WHERE s.form_id = ?
    `)
          .bind(`${publicId}-form`)
          .first(),
      );
      assert.deepEqual(row, { prior_same_sender: 0, prior_same_content: 0, has_outbox: 1 });
    }),
);

it.live("counts concurrent posts in D1 transaction order", () =>
  Effect.gen(function* () {
    const publicId = "intake-repetition-concurrent";
    yield* seedForm(publicId);
    const responses = yield* Effect.forEach(
      ["one", "two", "three"],
      (name) =>
        encode({ name, message: "Same concurrent message" }).pipe(
          Effect.flatMap((body) => submit(publicId, "application/json", body)),
        ),
      { concurrency: "unbounded" },
    );
    assert.deepEqual(
      responses.map(({ status }) => status),
      [202, 202, 202],
    );
    const { results } = yield* Effect.promise(() =>
      env.DB.prepare(`
      SELECT prior_same_content, intake_reason FROM submissions
      WHERE form_id = ? ORDER BY prior_same_content
    `)
        .bind(`${publicId}-form`)
        .all(),
    );
    assert.deepEqual(results, [
      { prior_same_content: 0, intake_reason: null },
      { prior_same_content: 1, intake_reason: null },
      { prior_same_content: 2, intake_reason: "repetition" },
    ]);
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

it.live("answers 415 to a body that is neither JSON nor a form body", () =>
  Effect.gen(function* () {
    yield* seedForm("intake-media");
    const responses = yield* Effect.all([
      submit("intake-media", "text/plain", "message=hello"),
      submit("intake-media", "application/xml", "<message>hello</message>"),
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
      // A repeated name is joined; the joined value has 4,002 characters.
      submit("intake-fields", form, `message=${"x".repeat(2000)}&message=${"x".repeat(2000)}`),
      submit("intake-fields", form, ""),
      submit("intake-fields", "multipart/form-data; boundary=x", "--x--"),
    ]);

    assert.deepEqual(
      responses.map(({ status }) => status),
      Array.from({ length: 12 }, () => 400),
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
    yield* expectStored("cors-fetch", 1);

    // A page that hides its origin sends `Origin: null`. Its message is stored like
    // one from a client without the header, and it gets no Access-Control-Allow-Origin.
    const opaque = yield* fetchJson("cors-fetch", "null");
    assert.deepEqual(cors(opaque), {
      status: 202,
      allowOrigin: null,
      vary: "Origin",
      credentials: null,
    });
    yield* expectStored("cors-fetch", 2);

    // A client without Origin, such as curl or a server, is accepted whatever the list.
    const server = yield* fetchJson("cors-fetch", null);
    assert.deepEqual(cors(server), {
      status: 202,
      allowOrigin: null,
      vary: "Origin",
      credentials: null,
    });
    yield* expectStored("cors-fetch", 3);

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

const readStored = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ fields: Schema.fromJsonString(Schema.Unknown) })),
);

/** The fields of each submission stored for a form, oldest first. */
const storedFields = (name: string) =>
  Effect.promise(() =>
    env.DB.prepare("SELECT fields FROM submissions WHERE form_id = ? ORDER BY received_at, rowid")
      .bind(`${name}-form`)
      .all(),
  ).pipe(
    Effect.flatMap(({ results }) => readStored(results)),
    Effect.map((rows) => rows.map(({ fields }) => fields)),
  );

const boundary = "rondyr-test-boundary";
const multipartType = `multipart/form-data; boundary=${boundary}`;

/** A multipart body written by hand, one part per Content-Disposition parameters and value. */
function multipartBody(parts: ReadonlyArray<readonly [string, string]>) {
  const encoded = parts.map(
    ([disposition, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; ${disposition}\r\n\r\n${value}\r\n`,
  );
  return `${encoded.join("")}--${boundary}--\r\n`;
}

const urlEncoded = "application/x-www-form-urlencoded";
const htmlAccept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";

it.live("joins the values of a repeated field name in a form body", () =>
  Effect.gen(function* () {
    yield* seedForm("intake-repeated");
    const checkboxes = yield* submit(
      "intake-repeated",
      urlEncoded,
      "topic=throwing&message=Hello&topic=glazing&topic=kiln",
    );
    assert.strictEqual(checkboxes.status, 202);
    const select = new FormData();
    select.append("days", "Monday");
    select.append("message", "Hi");
    select.append("days", "Friday");
    const multipart = yield* submit("intake-repeated", null, select);
    assert.strictEqual(multipart.status, 202);
    // Two values of 1,999 characters and the separator make exactly 4,000.
    const atLimit = yield* submit(
      "intake-repeated",
      urlEncoded,
      `long=${"x".repeat(1999)}&long=${"y".repeat(1999)}`,
    );
    assert.strictEqual(atLimit.status, 202);
    const overLimit = new FormData();
    overLimit.append("long", "x".repeat(2000));
    overLimit.append("long", "y".repeat(2000));
    const tooLong = yield* submit("intake-repeated", null, overLimit);
    assert.strictEqual(tooLong.status, 400);

    const stored = yield* storedFields("intake-repeated");
    assert.deepEqual(stored, [
      { topic: "throwing, glazing, kiln", message: "Hello" },
      { days: "Monday, Friday", message: "Hi" },
      { long: `${"x".repeat(1999)}, ${"y".repeat(1999)}` },
    ]);

    // JSON keeps string values only.
    const array = yield* submit("intake-repeated", "application/json", '{"topic":["a","b"]}');
    assert.strictEqual(array.status, 400);
    yield* expectStored("intake-repeated", 3);
  }),
);

it.live("accepts a multipart body of text fields and refuses a file", () =>
  Effect.gen(function* () {
    yield* seedForm("intake-multipart");
    const text = new FormData();
    text.append("email", "visitor@example.com");
    text.append("message", "Is there room in the pottery class?");
    const accepted = yield* submit("intake-multipart", null, text);
    assert.strictEqual(accepted.status, 202);
    const body = yield* Effect.promise(() => accepted.json());
    assert.include(body, { status: "received" });

    const withFile = new FormData();
    withFile.append("message", "See the attached file");
    withFile.append("attachment", new File(["hello"], "hello.txt", { type: "text/plain" }));
    // An empty file input still sends a part with a filename.
    const emptyFile = multipartBody([
      ['name="message"', "Hello"],
      ['name="attachment"; filename=""', ""],
    ]);
    const tooLarge = new FormData();
    tooLarge.append("message", "x".repeat(17 * 1024));
    const refused = yield* Effect.all([
      submit("intake-multipart", null, withFile),
      submit("intake-multipart", multipartType, emptyFile),
      submit("intake-multipart", "multipart/form-data", multipartBody([['name="a"', "b"]])),
      submit("intake-multipart", null, tooLarge),
    ]);
    assert.deepEqual(
      refused.map(({ status }) => status),
      [400, 400, 400, 413],
    );

    // A browser posting a multipart form gets the confirmation page.
    const page = yield* send("intake-multipart", {
      method: "POST",
      headers: { accept: htmlAccept },
      body: text,
    });
    assert.strictEqual(page.status, 202);
    assert.strictEqual(page.headers.get("content-type"), "text/html; charset=utf-8");

    const stored = yield* storedFields("intake-multipart");
    const sent = {
      email: "visitor@example.com",
      message: "Is there room in the pottery class?",
    };
    assert.deepEqual(stored, [sent, sent]);
  }),
);

it.live("refuses a field name with a control character or a line break", () =>
  Effect.gen(function* () {
    yield* seedForm("intake-names");
    const json = "application/json";
    const names = ["sub\nject", "sub\rject", "sub\u0000ject", "sub\u0085ject", "sub\u2028ject"];
    const jsonBodies = yield* Effect.forEach(names, (name) => encode({ [name]: "hello" }));
    // A browser escapes CR, LF and quotes in a part name, but a client can send other
    // controls. The multipart parser refuses most of them in a header; these pass it.
    const multipartNames = ["sub\tject", "sub\u0085ject", "sub\u2028ject", "sub\u0007ject"];
    const multipartBodies = multipartNames.map((name) =>
      multipartBody([[`name="${name}"`, "hello"]]),
    );
    const responses = yield* Effect.all([
      ...jsonBodies.map((body) => submit("intake-names", json, body)),
      ...names.map((name) =>
        submit("intake-names", urlEncoded, new URLSearchParams({ [name]: "hello" }).toString()),
      ),
      ...multipartBodies.map((body) => submit("intake-names", multipartType, body)),
    ]);
    assert.deepEqual(
      responses.map(({ status }) => status),
      Array.from({ length: names.length * 2 + multipartNames.length }, () => 400),
    );
    yield* expectStored("intake-names", 0);

    // The same names without the control character are accepted in each content type.
    const valid = yield* Effect.all([
      submit("intake-names", json, '{"subject":"hello"}'),
      submit("intake-names", urlEncoded, "subject=hello"),
      submit("intake-names", multipartType, multipartBody([['name="subject"', "hello"]])),
    ]);
    assert.deepEqual(
      valid.map(({ status }) => status),
      [202, 202, 202],
    );
    yield* expectStored("intake-names", 3);
  }),
);

const setStatus = (name: string, status: "active" | "suspended") =>
  Effect.promise(() =>
    env.DB.prepare("UPDATE forms SET status = ? WHERE id = ?").bind(status, `${name}-form`).run(),
  );

it.live("refuses a post to a suspended form and stores nothing", () =>
  Effect.gen(function* () {
    yield* seedForm("intake-suspended");
    yield* seedOrigins("intake-suspended", [shop]);
    yield* seedForm("intake-suspended-open");
    const before = yield* fetchJson("intake-suspended", shop);
    assert.strictEqual(before.status, 202);
    yield* setStatus("intake-suspended", "suspended");
    yield* setStatus("intake-suspended-open", "suspended");

    const refused = yield* Effect.all([
      fetchJson("intake-suspended", shop),
      fetchJson("intake-suspended", null),
      htmlPost("intake-suspended", shop),
      fetchJson("intake-suspended-open", elsewhere),
      // An origin that is not listed gets the origin refusal, as for an active form.
      fetchJson("intake-suspended", elsewhere),
    ]);
    assert.deepEqual(refused.map(cors), [
      { status: 403, allowOrigin: shop, vary: "Origin", credentials: null },
      { status: 403, allowOrigin: null, vary: "Origin", credentials: null },
      { status: 403, allowOrigin: shop, vary: "Origin", credentials: null },
      { status: 403, allowOrigin: "*", vary: null, credentials: null },
      { status: 403, allowOrigin: null, vary: "Origin", credentials: null },
    ]);
    for (const response of refused) {
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
    }
    // An invalid request keeps its status.
    const invalid = yield* fetchJson("intake-suspended", shop, '{"message":');
    assert.deepEqual(cors(invalid), {
      status: 400,
      allowOrigin: shop,
      vary: "Origin",
      credentials: null,
    });
    // The preflight answers as for an active form.
    const preflights = yield* Effect.all([
      preflight("intake-suspended", shop),
      preflight("intake-suspended-open", elsewhere),
    ]);
    assert.deepEqual(preflights.map(cors), [
      { status: 204, allowOrigin: shop, vary: "Origin", credentials: null },
      { status: 204, allowOrigin: "*", vary: null, credentials: null },
    ]);
    yield* expectStored("intake-suspended", 1);
    yield* expectStored("intake-suspended-open", 0);

    yield* setStatus("intake-suspended", "active");
    const reactivated = yield* fetchJson("intake-suspended", shop);
    assert.strictEqual(reactivated.status, 202);
    yield* expectStored("intake-suspended", 2);
  }),
);

const setSuccessUrl = (name: string, url: string | null) =>
  Effect.promise(() =>
    env.DB.prepare("UPDATE forms SET success_url = ? WHERE id = ?").bind(url, `${name}-form`).run(),
  );

it.live("redirects an accepted HTML form post to the form's success URL", () =>
  Effect.gen(function* () {
    const successUrl = `${shop}/merci?source=rondyr`;
    yield* seedForm("intake-redirect");
    yield* seedOrigins("intake-redirect", [shop]);
    yield* setSuccessUrl("intake-redirect", successUrl);

    // A field, a query parameter or a Referer cannot choose the destination.
    const redirected = yield* Effect.promise(() =>
      env.TEST_WORKER.fetch(
        new URL("/f/intake-redirect?redirect=https://evil.example.com/", origin),
        {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": urlEncoded,
            accept: htmlAccept,
            origin: shop,
            referer: "https://evil.example.com/page",
          },
          body: "message=Hello&_next=https%3A%2F%2Fevil.example.com%2F&redirect=https%3A%2F%2Fevil.example.com%2F",
        },
      ),
    );
    assert.strictEqual(redirected.status, 303);
    assert.strictEqual(redirected.headers.get("location"), successUrl);
    assert.strictEqual(redirected.headers.get("cache-control"), "no-store");
    assert.strictEqual(redirected.headers.get("access-control-allow-origin"), shop);

    const multipart = new FormData();
    multipart.append("message", "Hello");
    const responses = yield* Effect.all([
      send("intake-redirect", {
        method: "POST",
        redirect: "manual",
        headers: { accept: htmlAccept, origin: shop },
        body: multipart,
      }),
      // A JSON client gets the JSON answer, even if it accepts HTML.
      send("intake-redirect", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", accept: htmlAccept, origin: shop },
        body: contact,
      }),
      // A form post that does not accept HTML gets the JSON answer.
      send("intake-redirect", {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": urlEncoded, origin: shop },
        body: "message=Hello",
      }),
    ]);
    assert.deepEqual(
      responses.map((response) => [response.status, response.headers.get("location")]),
      [
        [303, successUrl],
        [202, null],
        [202, null],
      ],
    );
    for (const response of responses.slice(1)) {
      const body = yield* Effect.promise(() => response.json());
      assert.include(body, { status: "received" });
    }
    yield* expectStored("intake-redirect", 4);

    // A success URL whose origin is no longer listed, as after an edit by hand, is not used.
    yield* setSuccessUrl("intake-redirect", "https://elsewhere.example.com/merci");
    const unlisted = yield* htmlPost("intake-redirect", shop);
    assert.strictEqual(unlisted.status, 202);
    assert.strictEqual(unlisted.headers.get("location"), null);
    assert.strictEqual(unlisted.headers.get("content-type"), "text/html; charset=utf-8");
    yield* expectStored("intake-redirect", 5);
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
      // Never called: the requests have no client address.
      Layer.succeed(ClientRateLimit, { admit: () => Effect.succeed(true) }),
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

const [clientLimit] = wrangler.ratelimits;

/** A JSON submission from a client that Cloudflare identifies by `address`. */
const fromClient = (name: string, address: string, extra: Record<string, string> = {}) =>
  Effect.promise(() =>
    env.TEST_WORKER.fetch(new URL(`/f/${name}`, origin), {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": address, ...extra },
      body: '{"message":"hello"}',
    }),
  );

it.live("limits one client on a form while another client is still accepted", () =>
  Effect.gen(function* () {
    if (clientLimit === undefined) return assert.fail("wrangler.json declares no rate limit");
    const { limit } = clientLimit.simple;
    yield* seedForm("intake-client");
    yield* seedOrigins("intake-client", [shop]);

    // The binding counts in fixed windows of the wall clock. Twice the limit plus
    // one request fill at least one window past the limit, even if a window ends
    // during the test, and the first `limit` requests are always under it.
    const statuses: Array<number> = [];
    const limited: Array<Response> = [];
    for (let index = 0; index < 2 * limit + 1; index += 1) {
      const response = yield* fromClient("intake-client", "203.0.113.7", { origin: shop });
      statuses.push(response.status);
      if (response.status === 429) limited.push(response);
    }
    assert.deepEqual(
      statuses.slice(0, limit),
      Array.from({ length: limit }, () => 202),
    );
    assert.isNotEmpty(limited);
    assert.deepEqual(
      statuses.filter((status) => status !== 202 && status !== 429),
      [],
    );
    for (const response of limited) {
      assert.deepEqual(cors(response), {
        status: 429,
        allowOrigin: shop,
        vary: "Origin",
        credentials: null,
      });
      assert.strictEqual(response.headers.get("retry-after"), "60");
      assert.strictEqual(response.headers.get("access-control-expose-headers"), "retry-after");
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
    }
    const accepted = statuses.filter((status) => status === 202).length;
    // Nothing is stored for a refused request.
    yield* expectStored("intake-client", accepted);

    // Another client, and a client without an address, still reach the form.
    const other = yield* fromClient("intake-client", "198.51.100.4");
    assert.strictEqual(other.status, 202);
    const unidentified = yield* fetchJson("intake-client", shop);
    assert.strictEqual(unidentified.status, 202);
    yield* expectStored("intake-client", accepted + 2);
  }),
);

it.live("keeps the form's cap behind the per-client limit", () =>
  Effect.gen(function* () {
    yield* seedForm("intake-backstop");
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() =>
      env.DB.batch(
        Array.from({ length: 29 }, (_, index) =>
          env.DB.prepare(
            "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, ?)",
          ).bind(
            `00000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
            "intake-backstop-org",
            "intake-backstop-form",
            '{"message":"earlier"}',
            now,
          ),
        ),
      ),
    );
    // Each client is under its own limit; the form has room for one more message.
    const first = yield* fromClient("intake-backstop", "192.0.2.10");
    assert.strictEqual(first.status, 202);
    const second = yield* fromClient("intake-backstop", "2001:db8:5::20");
    assert.strictEqual(second.status, 429);
    assert.strictEqual(second.headers.get("retry-after"), "60");
    yield* expectStored("intake-backstop", 30);
  }),
);
