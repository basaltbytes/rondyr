import { applyD1Migrations } from "cloudflare:test";
import { env, withEnv } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Clock, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer, HttpServerResponse } from "effect/http";

import { testOrigin as origin } from "../../../tests/integration/auth-fixture.ts";
import {
  call,
  createInbox,
  json,
  signIn,
} from "../../../tests/integration/organization-fixture.ts";
import { secretCipherLive } from "../adapters/crypto/secret-cipher.ts";
import { submissionIntakeLive } from "../adapters/database/intake.ts";
import { outboxLive } from "../adapters/database/outbox.ts";
import { classificationQueueLive } from "../adapters/queues/classification-queue.ts";
import { turnstileVerifierLive } from "../adapters/workers/siteverify.ts";
import { CreatedApiToken } from "../../domain/organizations/api-token.ts";
import { turnstileField } from "../../domain/forms/turnstile.ts";
import { IdempotencyKey } from "../../domain/submissions/idempotency-key.ts";
import { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import { ApiTokens } from "../ports/api-tokens.ts";
import { BackgroundTasks } from "../ports/background-tasks.ts";
import { ClientRateLimit } from "../ports/client-rate-limit.ts";
import { SubmissionIntake } from "../ports/intake.ts";
import { StorageUnavailable } from "../ports/storage.ts";
import { apiTokenAuthentication, organizationPath } from "./api-token-authentication.ts";
import { submissionRoutes } from "./submission-routes.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readCreated = Schema.decodeUnknownEffect(CreatedApiToken);
const Accepted = Schema.Struct({
  "submission-id": SubmissionId,
  status: Schema.Literal("received"),
});
const readAccepted = Schema.decodeUnknownEffect(Accepted);
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** An organization with one form, and an API token of that organization. */
const siteWithToken = Effect.fnUntraced(function* (name: string) {
  const { cookie } = yield* signIn;
  const organization = yield* createInbox(name, { cookie });
  const form = organization.forms[0];
  if (form === undefined) return assert.fail("Expected a form");
  const created = yield* call(
    "POST",
    `/api/organizations/${organization.id}/api-tokens`,
    { name: "Site server" },
    { cookie },
  );
  assert.strictEqual(created.status, 201);
  const { id: tokenId, token } = yield* json(created).pipe(Effect.flatMap(readCreated));
  return { cookie, organization, publicId: form.publicId, tokenId, token };
});

const post = Effect.fnUntraced(function* (
  publicId: string,
  data: Schema.Json,
  headers: Record<string, string>,
) {
  const body = yield* encode(data);
  return yield* Effect.promise(() =>
    env.TEST_WORKER.fetch(new URL(`/f/${publicId}`, origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
});

const serverPost = (
  publicId: string,
  token: Redacted.Redacted<string>,
  body: Schema.Json = { email: "visitor@example.test", message: "Hello from the site" },
  headers: Record<string, string> = {},
) => post(publicId, body, { authorization: `Bearer ${Redacted.value(token)}`, ...headers });

const acceptedId = Effect.fnUntraced(function* (response: Response) {
  assert.strictEqual(response.status, 202);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/u);
  const body = yield* json(response).pipe(Effect.flatMap(readAccepted));
  return body["submission-id"];
});

/** The 202 response of a request, and the submission ID it returns. */
const accept = <E>(request: Effect.Effect<Response, E>) => Effect.flatMap(request, acceptedId);

const stored = (publicId: string) =>
  Effect.promise(() =>
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM submissions s JOIN forms f ON f.id = s.form_id
         WHERE f.public_id = ?1) AS submissions,
        (SELECT COUNT(*) FROM outbox_events o JOIN submissions s ON s.id = o.submission_id
         JOIN forms f ON f.id = s.form_id WHERE f.public_id = ?1) AS outbox
    `)
      .bind(publicId)
      .first(),
  );

const expectStored = (publicId: string, submissions: number) =>
  Effect.map(stored(publicId), (counts) =>
    assert.deepEqual(counts, { submissions, outbox: submissions }),
  );

const expectStatus = <E>(request: Effect.Effect<Response, E>, status: number) =>
  Effect.map(request, (response) => assert.strictEqual(response.status, status));

const formRowId = (publicId: string) =>
  Effect.promise(() =>
    env.DB.prepare("SELECT id FROM forms WHERE public_id = ?").bind(publicId).first<string>("id"),
  );

const expectReason = (id: SubmissionId, reason: string | null) =>
  Effect.promise(() =>
    env.DB.prepare("SELECT intake_reason FROM submissions WHERE id = ?")
      .bind(id)
      .first<string | null>("intake_reason"),
  ).pipe(Effect.map((found) => assert.strictEqual(found, reason)));

it.live("accepts a server intake on a form with allowed origins, from any origin", () =>
  Effect.gen(function* () {
    const { publicId, token } = yield* siteWithToken("Server intake origins");
    const formId = yield* formRowId(publicId);
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.promise(() =>
      env.DB.prepare("INSERT INTO form_origins (form_id, origin, created_at) VALUES (?, ?, ?)")
        .bind(formId, "https://site.example.test", now)
        .run(),
    );

    const plain = yield* serverPost(publicId, token);
    yield* acceptedId(plain);
    assert.isNull(plain.headers.get("access-control-allow-origin"));
    const elsewhere = yield* serverPost(publicId, token, undefined, {
      origin: "https://elsewhere.example.test",
    });
    yield* acceptedId(elsewhere);
    // The same request without the token is refused by the form's origin rule.
    const browser = yield* post(
      publicId,
      { email: "visitor@example.test", message: "Hello" },
      { origin: "https://elsewhere.example.test" },
    );
    assert.strictEqual(browser.status, 403);
    yield* expectStored(publicId, 2);
  }),
);

it.live("answers JSON to a server intake that asks for HTML, and refuses a form body", () =>
  Effect.gen(function* () {
    const { publicId, token } = yield* siteWithToken("Server intake media");
    yield* accept(serverPost(publicId, token, undefined, { accept: "text/html" }));
    const form = yield* Effect.promise(() =>
      env.TEST_WORKER.fetch(new URL(`/f/${publicId}`, origin), {
        method: "POST",
        headers: { authorization: `Bearer ${Redacted.value(token)}`, accept: "text/html" },
        body: new URLSearchParams({ email: "visitor@example.test", message: "Hello" }),
      }),
    );
    assert.strictEqual(form.status, 415);
    yield* expectStored(publicId, 1);
  }),
);

it.live("skips the per-client limit for a server intake and keeps the form cap", () =>
  Effect.gen(function* () {
    const { publicId, token } = yield* siteWithToken("Server intake limits");
    const address = { "cf-connecting-ip": "192.0.2.59" };
    for (let index = 0; index < 30; index += 1) {
      const response = yield* serverPost(
        publicId,
        token,
        { email: `sender-${index}@example.test`, message: `Message number ${index}` },
        address,
      );
      assert.strictEqual(response.status, 202, `request ${index + 1}`);
    }
    const capped = yield* serverPost(publicId, token, undefined, address);
    assert.strictEqual(capped.status, 429);
    assert.strictEqual(capped.headers.get("retry-after"), "60");
    yield* expectStored(publicId, 30);
  }),
);

it.live("refuses an unknown, revoked or foreign token without storing anything", () =>
  Effect.gen(function* () {
    const site = yield* siteWithToken("Server intake refusals");
    const other = yield* siteWithToken("Server intake other organization");

    const unknown = Redacted.make(`rdr_${"A".repeat(43)}`);
    yield* expectStatus(serverPost(site.publicId, unknown), 401);
    // Any Authorization header makes a server intake, whatever its scheme or
    // value: it never falls back to the public path.
    const token = Redacted.value(site.token);
    const credentials = [
      "Bearer x",
      "Bearer",
      `Basic ${btoa("site:password")}`,
      `Token ${token}`,
      token,
      `Bearer ${token}, Bearer ${token}`,
    ];
    for (const [index, authorization] of credentials.entries()) {
      const refused = yield* post(site.publicId, { message: "Hello" }, { authorization });
      assert.strictEqual(refused.status, 401, `credential ${index}`);
    }
    yield* expectStatus(serverPost(site.publicId, other.token), 404);

    const revoked = yield* call(
      "DELETE",
      `/api/organizations/${site.organization.id}/api-tokens?id=${site.tokenId}`,
      undefined,
      { cookie: site.cookie },
    );
    assert.strictEqual(revoked.status, 204);
    yield* expectStatus(serverPost(site.publicId, site.token), 401);
    yield* expectStored(site.publicId, 0);
  }),
);

it.live("answers a replayed key with the first submission and stores nothing", () =>
  Effect.gen(function* () {
    const { publicId, token } = yield* siteWithToken("Server intake replay");
    const key = { "idempotency-key": "emdash-01JD8Z3K9Q" };
    const first = yield* accept(serverPost(publicId, token, undefined, key));
    const replay = yield* accept(serverPost(publicId, token, { message: "A different body" }, key));
    assert.strictEqual(replay, first);
    yield* expectStored(publicId, 1);
  }),
);

it.live(
  "keeps the idempotency key out of the export, and frees it when the message is deleted",
  () =>
    Effect.gen(function* () {
      const { cookie, organization, publicId, token } = yield* siteWithToken("Deleted key");
      const key = { "idempotency-key": "emdash-deleted-key-7f3a" };
      const first = yield* accept(serverPost(publicId, token, undefined, key));
      const submissions = `/api/organizations/${organization.id}/submissions`;

      const exported = yield* call(
        "GET",
        `/api/organizations/${organization.id}/submission-export?format=jsonl`,
        undefined,
        { cookie },
      );
      const lines = yield* Effect.promise(() => exported.text());
      const deleted = yield* call("DELETE", `${submissions}/${first}`, undefined, { cookie });
      // The same key after the deletion stores a new message.
      const second = yield* accept(serverPost(publicId, token, undefined, key));

      assert.include(lines, first);
      assert.notInclude(lines, "emdash-deleted-key-7f3a");
      assert.strictEqual(deleted.status, 204);
      assert.notStrictEqual(second, first);
      yield* expectStored(publicId, 1);
    }),
);

const usage = (organizationId: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      "SELECT submissions, classifications, junk FROM organization_daily_usage WHERE organization_id = ?",
    )
      .bind(organizationId)
      .first(),
  );

it.live("answers a replay while the form cap is reached, without taking a slot", () =>
  Effect.gen(function* () {
    const { publicId, token } = yield* siteWithToken("Server intake replay at the cap");
    const ids: Array<SubmissionId> = [];
    for (let index = 0; index < 30; index += 1) {
      const body = { email: `sender-${index}@example.test`, message: `Message number ${index}` };
      const key = { "idempotency-key": `cap-${index}` };
      const id = yield* accept(serverPost(publicId, token, body, key));
      ids.push(id);
    }
    const fresh = yield* serverPost(publicId, token, undefined, { "idempotency-key": "cap-new" });
    assert.strictEqual(fresh.status, 429);
    assert.strictEqual(fresh.headers.get("retry-after"), "60");
    const replay = yield* accept(
      serverPost(publicId, token, undefined, { "idempotency-key": "cap-0" }),
    );
    assert.strictEqual(replay, ids[0]);
    yield* expectStored(publicId, 30);
  }),
);

it.live("applies the organization's daily quota, and a replay takes no slot", () =>
  Effect.gen(function* () {
    const { cookie, organization, publicId, token } = yield* siteWithToken("Server intake quota");
    const quotas = yield* call(
      "PUT",
      `/api/organizations/${organization.id}/quotas`,
      { submissions: 1, classifications: 1000 },
      { cookie },
    );
    assert.strictEqual(quotas.status, 200);
    const first = yield* accept(
      serverPost(publicId, token, undefined, { "idempotency-key": "quota-first" }),
    );
    const refused = yield* serverPost(
      publicId,
      token,
      { email: "another@example.test", message: "Another message" },
      { "idempotency-key": "quota-second" },
    );
    assert.strictEqual(refused.status, 429);
    const retryAfter = Number(refused.headers.get("retry-after"));
    assert.isTrue(retryAfter > 0 && retryAfter <= 86_400, `Retry-After: ${retryAfter}`);
    const replay = yield* accept(
      serverPost(publicId, token, undefined, { "idempotency-key": "quota-first" }),
    );
    assert.strictEqual(replay, first);
    const counters = yield* usage(organization.id);
    assert.deepEqual(counters, { submissions: 1, classifications: 1, junk: 0 });
    yield* expectStored(publicId, 1);
  }),
);

it.live("refuses a suspended form with 403 and stores nothing", () =>
  Effect.gen(function* () {
    const { cookie, organization, publicId, token } =
      yield* siteWithToken("Server intake suspended");
    const suspended = yield* call(
      "POST",
      `/api/organizations/${organization.id}/forms/${publicId}/suspend`,
      undefined,
      { cookie },
    );
    assert.strictEqual(suspended.status, 200);
    yield* expectStatus(serverPost(publicId, token), 403);
    yield* expectStored(publicId, 0);
  }),
);

it.live("answers 503 when the token can't be checked, and 401 to an empty header", () =>
  Effect.gen(function* () {
    const unavailableTokens = Layer.succeed(ApiTokens, {
      verify: () => Effect.fail(StorageUnavailable.make()),
      list: () => Effect.fail(StorageUnavailable.make()),
      create: () => Effect.fail(StorageUnavailable.make()),
      revoke: () => Effect.fail(StorageUnavailable.make()),
    });
    const reached: Array<string> = [];
    const intake = Layer.succeed(SubmissionIntake, {
      receive: () => Effect.sync(() => reached.push("receive")).pipe(Effect.andThen(Effect.never)),
      receiveFromServer: () =>
        Effect.sync(() => reached.push("receiveFromServer")).pipe(Effect.andThen(Effect.never)),
      matchOrigin: () =>
        Effect.sync(() => reached.push("matchOrigin")).pipe(Effect.andThen(Effect.never)),
    });
    const services = yield* Layer.build(
      Layer.mergeAll(
        intake,
        Layer.succeed(BackgroundTasks, { run: () => Effect.void }),
        Layer.succeed(ClientRateLimit, { admit: () => Effect.succeed(true) }),
        // Never called: nothing is stored, so nothing is published.
        outboxLive,
        classificationQueueLive,
      ),
    );
    const organizations = HttpRouter.add(
      "GET",
      organizationPath,
      Effect.sync(() => {
        reached.push("organizations");
        return HttpServerResponse.empty({ status: 200 });
      }),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.mergeAll(submissionRoutes, organizations).pipe(
        Layer.provide(apiTokenAuthentication.pipe(Layer.provide(unavailableTokens))),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    );
    const authorization = `Bearer rdr_${"A".repeat(43)}`;
    const requests = [
      new Request(new URL("/f/tokens-down", origin), {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: '{"message":"Hello"}',
      }),
      new Request(new URL(organizationPath, origin), { headers: { authorization } }),
      // An empty header is still a server intake. It is refused before any lookup.
      new Request(new URL("/f/tokens-down", origin), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "" },
        body: '{"message":"Hello"}',
      }),
    ];
    const statuses = yield* Effect.forEach(requests, (request) =>
      Effect.promise(() => handler(request, services)).pipe(Effect.map(({ status }) => status)),
    );
    assert.deepEqual(statuses, [503, 503, 401]);
    assert.deepEqual(reached, []);
    yield* Effect.promise(dispose);
  }).pipe(Effect.scoped),
);

it.live("stores one submission for two concurrent requests with the same key", () =>
  Effect.gen(function* () {
    const { publicId, token } = yield* siteWithToken("Server intake concurrency");
    const key = { "idempotency-key": "concurrent-key" };
    const responses = yield* Effect.all(
      [serverPost(publicId, token, undefined, key), serverPost(publicId, token, undefined, key)],
      { concurrency: "unbounded" },
    );
    const ids = yield* Effect.forEach(responses, acceptedId);
    assert.strictEqual(ids[0], ids[1]);
    yield* expectStored(publicId, 1);
  }),
);

it.live("scopes a key to its form", () =>
  Effect.gen(function* () {
    const { organization, publicId, token } = yield* siteWithToken("Server intake key scope");
    const second = `${publicId}-second`;
    yield* Effect.promise(() =>
      env.DB.prepare("INSERT INTO forms (id, organization_id, public_id, name) VALUES (?, ?, ?, ?)")
        .bind(`${second}-form`, organization.id, second, "Second form")
        .run(),
    );
    const key = { "idempotency-key": "shared-key" };
    const first = yield* accept(serverPost(publicId, token, undefined, key));
    const other = yield* accept(serverPost(second, token, undefined, key));
    assert.notStrictEqual(first, other);
    yield* expectStored(publicId, 1);
    yield* expectStored(second, 1);
  }),
);

it.live("ignores the key of a request without a token", () =>
  Effect.gen(function* () {
    const { publicId } = yield* siteWithToken("Server intake public key");
    const body = { email: "visitor@example.test", message: "Hello" };
    const headers = { "idempotency-key": "public-key" };
    const first = yield* accept(post(publicId, body, headers));
    const second = yield* accept(post(publicId, body, headers));
    assert.notStrictEqual(first, second);
    yield* expectStored(publicId, 2);
  }),
);

it.live("refuses a malformed key", () =>
  Effect.gen(function* () {
    const { publicId, token } = yield* siteWithToken("Server intake malformed key");
    for (const key of ["", "k".repeat(129)]) {
      yield* expectStatus(serverPost(publicId, token, undefined, { "idempotency-key": key }), 400);
    }
    yield* accept(serverPost(publicId, token, undefined, { "idempotency-key": "k".repeat(128) }));
    yield* expectStored(publicId, 1);
  }),
);

it.live("quarantines a filled honeypot field of a server intake", () =>
  Effect.gen(function* () {
    const { publicId, token } = yield* siteWithToken("Server intake honeypot");
    yield* Effect.promise(() =>
      env.DB.prepare("UPDATE forms SET honeypot_field = '_hp' WHERE public_id = ?")
        .bind(publicId)
        .run(),
    );
    const id = yield* accept(serverPost(publicId, token, { message: "Buy now", _hp: "filled" }));
    yield* expectReason(id, "honeypot");
  }),
);

it.live("does not apply Turnstile to a server intake", () =>
  Effect.gen(function* () {
    const { cookie, organization, publicId, token } =
      yield* siteWithToken("Server intake Turnstile");
    const configured = yield* call(
      "PUT",
      `/api/organizations/${organization.id}/forms/${publicId}/turnstile`,
      { siteKey: "workerd_fixture_site_key", secretKey: "workerd-fixture-secret-server" },
      { cookie },
    );
    assert.strictEqual(configured.status, 200);
    const body = { email: "visitor@example.test", message: "Hello", [turnstileField]: "x" };
    const server = yield* accept(serverPost(publicId, token, body));
    yield* expectReason(server, null);
    // A browser request without a valid token is quarantined, as before.
    const browser = yield* accept(post(publicId, { message: "Hello" }, {}));
    yield* expectReason(browser, "turnstile-failed");
  }),
);

const verify = { "rondyr-turnstile": "verify" };

const protectedSite = Effect.fnUntraced(function* (name: string) {
  const site = yield* siteWithToken(`Server Turnstile ${name}`);
  const secret = `server-turnstile-${name}`;
  const result = yield* call(
    "PUT",
    `/api/organizations/${site.organization.id}/forms/${site.publicId}/turnstile`,
    { siteKey: "server_site_key", secretKey: secret },
    { cookie: site.cookie },
  );
  assert.strictEqual(result.status, 200);
  return { ...site, secret };
});

const readChecks = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      secret: Schema.String,
      token: Schema.String,
      remoteip: Schema.optionalKey(Schema.String),
    }),
  ),
);

const checksFor = (secret: string) =>
  Effect.promise(() =>
    env.SITEVERIFY_FIXTURE.fetch(`https://siteverify.test/__calls?secret=${secret}`),
  ).pipe(Effect.flatMap(json), Effect.flatMap(readChecks));

it.live("verifies a server token with the forwarded visitor IP", () =>
  Effect.gen(function* () {
    const { publicId, token, secret } = yield* protectedSite("valid");
    const response = `valid-${secret}`;

    const id = yield* accept(
      serverPost(
        publicId,
        token,
        {
          message: "Hello",
          [turnstileField]: response,
        },
        { ...verify, "rondyr-visitor-ip": "2001:db8::8" },
      ),
    );

    yield* expectReason(id, null);
    const checks = yield* checksFor(secret);
    assert.deepEqual(checks, [
      { secret, token: "XXXX.DUMMY.TOKEN.XXXX" },
      { secret, token: response, remoteip: "2001:db8::8" },
    ]);
  }),
);

for (const response of ["refused-with-400", "expired", undefined]) {
  it.live(`stores a server submission for review when its token is ${response ?? "missing"}`, () =>
    Effect.gen(function* () {
      const { publicId, token } = yield* protectedSite(response ?? "missing");

      const body =
        response === undefined
          ? { message: "Hello" }
          : { message: "Hello", [turnstileField]: response };
      const id = yield* accept(serverPost(publicId, token, body, verify));

      yield* expectReason(id, "turnstile-failed");
      yield* expectStored(publicId, 1);
    }),
  );
}

it.live("returns the stored ID on replay without checking the expired token", () =>
  Effect.gen(function* () {
    const { publicId, token, secret } = yield* protectedSite("replay");
    const headers = { ...verify, "idempotency-key": "server-turnstile-replay" };
    const first = yield* accept(
      serverPost(
        publicId,
        token,
        {
          message: "Hello",
          [turnstileField]: `valid-${secret}`,
        },
        headers,
      ),
    );

    const replay = yield* accept(
      serverPost(
        publicId,
        token,
        {
          message: "Hello",
          [turnstileField]: "expired",
        },
        headers,
      ),
    );

    assert.strictEqual(replay, first);
    const checks = yield* checksFor(secret);
    assert.lengthOf(checks, 2);
    yield* expectStored(publicId, 1);
  }),
);

it.live("ignores the forwarded visitor IP on a browser intake", () =>
  Effect.gen(function* () {
    const { publicId, secret } = yield* protectedSite("browser");

    const id = yield* accept(
      post(
        publicId,
        {
          message: "Hello",
          [turnstileField]: `valid-${secret}`,
        },
        { ...verify, "rondyr-visitor-ip": "192.0.2.10" },
      ),
    );

    yield* expectReason(id, null);
    const checks = yield* checksFor(secret);
    assert.deepEqual(checks, [
      { secret, token: "XXXX.DUMMY.TOKEN.XXXX" },
      { secret, token: `valid-${secret}` },
    ]);
  }),
);

it.live("ignores the verification header on a form without keys", () =>
  Effect.gen(function* () {
    const { publicId, token } = yield* siteWithToken("Server Turnstile without keys");

    const id = yield* accept(serverPost(publicId, token, undefined, verify));

    yield* expectReason(id, null);
  }),
);

it.live("stores a server intake with its key in one D1 call", () =>
  Effect.gen(function* () {
    const publicId = "server-intake-round-trip";
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(
          `${publicId}-org`,
          publicId,
        ),
        env.DB.prepare(
          "INSERT INTO forms (id, organization_id, public_id, name) VALUES (?, ?, ?, ?)",
        ).bind(`${publicId}-form`, `${publicId}-org`, publicId, publicId),
      ]),
    );
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
    const intake = {
      organizationId: OrganizationId.make(`${publicId}-org`),
      idempotencyKey: Option.some(IdempotencyKey.make("one-round-trip")),
    };
    const receive = SubmissionIntake.use((service) =>
      service.receiveFromServer(publicId, { message: "One D1 call" }, intake),
    );
    const verifier = turnstileVerifierLive.pipe(
      Layer.provide([secretCipherLive, FetchHttpClient.layer]),
    );
    const services = yield* Layer.build(submissionIntakeLive.pipe(Layer.provide(verifier)));
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
    yield* expectStored(publicId, 1);
    // The same key, outside the spy: the batch finds the stored submission.
    const replay = yield* receive.pipe(Effect.provideContext(services));
    assert.isTrue(replay.replayed);
    yield* expectStored(publicId, 1);
  }),
);
