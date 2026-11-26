import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin as origin } from "../../../tests/integration/auth-fixture.ts";
import { setupOwner } from "../../../tests/integration/organization-fixture.ts";
import { FormOrigin, type OriginRefusalReason } from "../../domain/forms/allowed-origin.ts";
import { InboxOrganizationWithForms } from "../../domain/submissions/inbox-setup.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const readOrigins = Schema.decodeUnknownEffect(Schema.Array(FormOrigin));
const readOrigin = Schema.decodeUnknownEffect(FormOrigin);

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

function request(path: string, init?: RequestInit) {
  return Effect.promise(() => env.TEST_WORKER.fetch(new URL(path, origin), init));
}

const post = Effect.fnUntraced(function* (path: string, data: Schema.Json, extra?: HeadersInit) {
  const body = yield* encode(data);
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("origin", origin);
  return yield* request(path, { method: "POST", headers, body });
});

const json = (response: Response) => Effect.promise(() => response.json());

const statusOf = (response: Response) => response.status;

const withBody = (response: Response) =>
  Effect.map(json(response), (body) => ({ status: response.status, body }));

const storedOrigins = (publicId: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      "SELECT o.origin FROM form_origins o JOIN forms f ON f.id = o.form_id WHERE f.public_id = ? ORDER BY o.origin",
    )
      .bind(publicId)
      .all(),
  ).pipe(Effect.map(({ results }) => results.map((row) => row.origin)));

it.live("manages the allowed origins of the account's forms and refuses other organizations", () =>
  Effect.gen(function* () {
    const { cookie } = yield* setupOwner({ name: "Origins", email: "origins@example.test" });
    const headers = { cookie, origin };
    const created = yield* post(
      "/api/organizations",
      { organizationName: "Bakery", formName: "Orders", businessContext: "" },
      headers,
    );
    assert.strictEqual(created.status, 201);
    const inboxes = yield* request("/api/organizations", { headers }).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readInboxes),
    );
    const inbox = inboxes[0];
    const form = inbox?.forms[0];
    if (inbox === undefined || form === undefined) return assert.fail("Expected a form");
    const formOrigins = `/api/organizations/${inbox.id}/forms/${form.publicId}/origins`;
    const remove = (value: string, extra: HeadersInit = headers) =>
      request(`${formOrigins}?${new URLSearchParams({ origin: value })}`, {
        method: "DELETE",
        headers: extra,
      });

    const anonymous = yield* Effect.all([
      request(formOrigins),
      post(formOrigins, { origin: "https://shop.example.com" }),
      remove("https://shop.example.com", { origin }),
    ]);
    assert.deepEqual(anonymous.map(statusOf), [401, 401, 401]);
    const empty = yield* request(formOrigins, { headers }).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readOrigins),
    );
    assert.deepEqual(empty, []);

    // Refused when added, with the reason the dashboard shows.
    const refusedOrigins: ReadonlyArray<readonly [string, OriginRefusalReason]> = [
      ["shop.example.com", "invalid-origin"],
      ["https://*.example.com", "wildcard"],
      ["http://shop.example.com", "not-https"],
      ["https://user:secret@shop.example.com", "credentials"],
      ["https://shop.example.com/contact", "not-an-origin"],
    ];
    const refusals = yield* Effect.forEach(refusedOrigins, ([value]) =>
      post(formOrigins, { origin: value }, headers).pipe(Effect.flatMap(withBody)),
    );
    assert.deepEqual(
      refusals,
      refusedOrigins.map(([, reason]) => ({
        status: 400,
        body: { error: "origin-refused", reason },
      })),
    );
    const malformed = yield* post(formOrigins, { url: "https://shop.example.com" }, headers);
    assert.strictEqual(malformed.status, 400);
    yield* storedOrigins(form.publicId).pipe(Effect.map((stored) => assert.deepEqual(stored, [])));

    // Stored normalized; adding it again in another spelling changes nothing.
    const added = yield* post(formOrigins, { origin: "HTTPS://Shop.Example.com:443/" }, headers);
    assert.strictEqual(added.status, 201);
    assert.strictEqual(added.headers.get("cache-control"), "no-store");
    const shop = yield* json(added).pipe(Effect.flatMap(readOrigin));
    assert.strictEqual(shop.origin, "https://shop.example.com");
    const again = yield* post(formOrigins, { origin: "https://shop.example.com" }, headers);
    assert.strictEqual(again.status, 200);
    const unchanged = yield* json(again).pipe(Effect.flatMap(readOrigin));
    assert.deepEqual(unchanged, shop);
    const local = yield* post(formOrigins, { origin: "http://localhost:4321" }, headers);
    assert.strictEqual(local.status, 201);
    const listed = yield* request(formOrigins, { headers }).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readOrigins),
    );
    assert.deepEqual(
      listed.map(({ origin: value }) => value),
      ["https://shop.example.com", "http://localhost:4321"],
    );

    const removed = yield* remove("https://shop.example.com/");
    assert.strictEqual(removed.status, 204);
    const removedTwice = yield* remove("https://shop.example.com");
    assert.strictEqual(removedTwice.status, 404);
    const removeRefused = yield* remove("https://shop.example.com/contact").pipe(
      Effect.flatMap(withBody),
    );
    assert.deepEqual(removeRefused, {
      status: 400,
      body: { error: "origin-refused", reason: "not-an-origin" },
    });
    const remaining = yield* request(formOrigins, { headers }).pipe(
      Effect.flatMap(json),
      Effect.flatMap(readOrigins),
    );
    assert.deepEqual(
      remaining.map(({ origin: value }) => value),
      ["http://localhost:4321"],
    );

    // Another organization's form answers 404 and keeps its list.
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('other-org', 'Other')"),
        env.DB.prepare(
          "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('other-form', 'other-org', 'other', 'Other')",
        ),
        env.DB.prepare(
          "INSERT INTO form_origins (form_id, origin, created_at) VALUES ('other-form', 'https://other.example.com', 0)",
        ),
      ]),
    );
    const foreignForm = "/api/organizations/other-org/forms/other/origins";
    const mixedForm = `/api/organizations/${inbox.id}/forms/other/origins`;
    const foreignRemove = (path: string) =>
      request(`${path}?origin=${encodeURIComponent("https://other.example.com")}`, {
        method: "DELETE",
        headers,
      });
    const foreign = yield* Effect.all([
      request(foreignForm, { headers }),
      request(mixedForm, { headers }),
      post(foreignForm, { origin: "https://intruder.example.com" }, headers),
      post(mixedForm, { origin: "https://intruder.example.com" }, headers),
      foreignRemove(foreignForm),
      foreignRemove(mixedForm),
    ]);
    assert.deepEqual(foreign.map(statusOf), [404, 404, 404, 404, 404, 404]);
    yield* storedOrigins("other").pipe(
      Effect.map((stored) => assert.deepEqual(stored, ["https://other.example.com"])),
    );
  }),
);
