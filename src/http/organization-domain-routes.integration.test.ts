import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin as origin, testSetupToken } from "../../tests/integration/auth-fixture.ts";
import { ClassifierInput } from "../domain/submissions/classifier-input.ts";
import { InboxOrganizationWithForms } from "../domain/submissions/inbox-setup.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const readDomains = Schema.decodeUnknownEffect(Schema.Array(Schema.String));
const readStates = Schema.decodeUnknownPromise(Schema.Array(ClassifierInput));
const json = (response: Response) => Effect.promise(() => response.json());
const statuses = (responses: readonly Response[]) => responses.map(({ status }) => status);

const call = Effect.fnUntraced(function* (
  method: string,
  path: string,
  data?: Schema.Json,
  extra?: HeadersInit,
) {
  const headers = new Headers(extra);
  headers.set("origin", origin);
  const url = new URL(path, origin);
  if (data === undefined)
    return yield* Effect.promise(() => env.TEST_WORKER.fetch(url, { method, headers }));
  headers.set("content-type", "application/json");
  const body = yield* encode(data);
  return yield* Effect.promise(() => env.TEST_WORKER.fetch(url, { method, headers, body }));
});

const signIn = Effect.runSync(
  Effect.cached(
    Effect.gen(function* () {
      const credentials = {
        email: "domain-admin@example.test",
        password: "domain-admin-test-password",
      };
      const setup = yield* call(
        "POST",
        "/api/setup",
        { name: "Domain admin", ...credentials },
        {
          authorization: `Bearer ${testSetupToken}`,
        },
      );
      assert.strictEqual(setup.status, 201);
      const session = yield* call("POST", "/api/auth/sign-in/email", credentials);
      assert.strictEqual(session.status, 200);
      const cookie = session.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      return { cookie };
    }),
  ),
);

const createInbox = Effect.fnUntraced(function* (organizationName: string, headers: HeadersInit) {
  const created = yield* call(
    "POST",
    "/api/organizations",
    { organizationName, formName: "Contact", businessContext: "" },
    headers,
  );
  assert.strictEqual(created.status, 201);
  const inboxes = yield* call("GET", "/api/organizations", undefined, headers).pipe(
    Effect.flatMap(json),
    Effect.flatMap(readInboxes),
  );
  const inbox = inboxes.find(({ name }) => name === organizationName);
  if (inbox === undefined) return assert.fail("Expected the new organization");
  return inbox;
});

const domainsOf = (organizationId: string) => `/api/organizations/${organizationId}/domains`;
const removePath = (path: string, domain: string) => `${path}?${new URLSearchParams({ domain })}`;

it.live(
  "lists domains, refuses invalid hostnames and enforces ten domains across concurrent adds",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const inbox = yield* createInbox("Domain limit", headers);
      const path = domainsOf(inbox.id);
      const add = (domain: string) => call("POST", path, { domain }, headers);
      const list = () =>
        call("GET", path, undefined, headers).pipe(
          Effect.tap((response) => Effect.sync(() => assert.strictEqual(response.status, 200))),
          Effect.flatMap(json),
          Effect.flatMap(readDomains),
        );

      const empty = yield* list();
      assert.deepEqual(empty, []);
      const invalid = [
        "https://studio.example",
        "studio.example/workshops",
        "studio.example:443",
        "STUDIO.example",
        "*.studio.example",
        "atelier..example",
        "-studio.example",
        "étude.example",
        "owner@studio.example",
        "studio.example.",
        "127.0.0.1",
        `${"a".repeat(64)}.example`,
      ];
      const invalidResponses = yield* Effect.forEach(invalid, add);
      assert.deepEqual(
        statuses(invalidResponses),
        invalid.map(() => 400),
      );
      const initial = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map(
        (label) => `${label}.example`,
      );
      const initialResponses = yield* Effect.forEach(initial, add);
      assert.deepEqual(
        statuses(initialResponses),
        initial.map(() => 201),
      );

      const contenders = yield* Effect.all([add("j.example"), add("k.example")], {
        concurrency: 2,
      });
      assert.deepEqual(statuses(contenders).toSorted(), [201, 409]);
      const full = yield* list();
      assert.lengthOf(full, 10);
      assert.strictEqual((yield* add("a.example")).status, 200);
      const removed = yield* call("DELETE", removePath(path, "a.example"), undefined, headers);
      assert.strictEqual(removed.status, 204);
      assert.strictEqual((yield* add("new.example")).status, 201);
      const updated = yield* list();
      assert.notInclude(updated, "a.example");
    }),
);

it.live("returns 404 for all domain operations on an organization outside the account", () =>
  Effect.gen(function* () {
    const headers = yield* signIn;
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare(
          "INSERT INTO organizations (id, name) VALUES ('foreign-domains', 'Foreign')",
        ),
        env.DB.prepare(
          "INSERT INTO organization_domains (organization_id, domain) VALUES ('foreign-domains', 'private.example')",
        ),
      ]),
    );
    const path = domainsOf("foreign-domains");

    const responses = yield* Effect.all([
      call("GET", path, undefined, headers),
      call("POST", path, { domain: "another.example" }, headers),
      call("DELETE", removePath(path, "private.example"), undefined, headers),
    ]);

    assert.deepEqual(statuses(responses), [404, 404, 404]);
    const stored = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT domain FROM organization_domains WHERE organization_id = 'foreign-domains'",
      ).all(),
    );
    assert.deepEqual(stored.results, [{ domain: "private.example" }]);
  }),
);

it.live(
  "sends the fact for exact and child domains and omits it for every other sender",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const inbox = yield* createInbox("Organization matching", headers);
      const other = yield* createInbox("No declared domains", headers);
      const form = inbox.forms[0];
      const otherForm = other.forms[0];
      if (form === undefined || otherForm === undefined)
        return assert.fail("Expected a form in each organization");
      const added = yield* call("POST", domainsOf(inbox.id), { domain: "studio.example" }, headers);
      assert.strictEqual(added.status, 201);

      // [form, message, submitted email, fact present in the model input, email in the model input]
      const messages = [
        [form.publicId, "Exact domain", "lea@studio.example", true, ""],
        [form.publicId, "Subdomain", "ops+forms@Team.Studio.Example", true, ""],
        [
          form.publicId,
          "Invalid address",
          "lea..ops@studio.example",
          false,
          "lea..ops@studio.example",
        ],
        [
          form.publicId,
          "Lookalike domain",
          "lea@other-studio.example",
          false,
          "lea@other-studio.example",
        ],
        [
          form.publicId,
          "Misleading suffix",
          "lea@notstudio.example",
          false,
          "lea@notstudio.example",
        ],
        [form.publicId, "Missing email", undefined, false, undefined],
        [
          otherForm.publicId,
          "Other organization",
          "lea@studio.example",
          false,
          "lea@studio.example",
        ],
      ] as const;
      yield* Effect.forEach(messages, ([publicId, message, email]) =>
        call(
          "POST",
          `/f/${publicId}`,
          email === undefined
            ? { message, "fixture-verdict": "accept" }
            : { message, email, "fixture-verdict": "accept" },
        ).pipe(
          Effect.tap((response) => Effect.sync(() => assert.strictEqual(response.status, 202))),
        ),
      );

      const calls = yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.WORKERS_AI_FIXTURE.fetch("https://workers-ai.test/__states")
              .then((response) => response.json())
              .then(readStates)
              .then((states) =>
                messages.map(([, message]) => {
                  const state = states.find(
                    ({ submission_fields }) => submission_fields.message === message,
                  );
                  if (state === undefined) return assert.fail(`No model call for ${message}`);
                  return {
                    // readStates only accepts `true` for this key.
                    fact: Object.hasOwn(state.facts, "sender_matches_organization_domain"),
                    email: state.submission_fields.email,
                  };
                }),
              ),
          { timeout: 20_000, interval: 100 },
        ),
      );
      assert.deepEqual(
        calls,
        messages.map(([, , , fact, email]) => ({ fact, email })),
      );
    }),
  30_000,
);
