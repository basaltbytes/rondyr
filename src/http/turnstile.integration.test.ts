import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin } from "../../tests/integration/auth-fixture.ts";
import { call, createInbox, json, signIn } from "../../tests/integration/organization-fixture.ts";
import { ManagedForm } from "../domain/forms/form.ts";
import { turnstileField } from "../domain/forms/turnstile.ts";
import { SubmissionDetail } from "../domain/submissions/inbox.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readDetail = Schema.decodeUnknownPromise(SubmissionDetail);
const readForm = Schema.decodeUnknownEffect(ManagedForm);

const formFor = Effect.fnUntraced(function* (name: string, headers: HeadersInit) {
  const organization = yield* createInbox(name, headers);
  const form = organization.forms[0];
  if (form === undefined) return assert.fail("Expected a form");
  return {
    organization,
    form,
    path: `/api/organizations/${organization.id}/forms/${form.publicId}/turnstile`,
  };
});

const siteKey = "workerd_fixture_site_key";
// Cloudflare's dummy token, which the Worker sends to Siteverify to check a secret key.
const dummyToken = "XXXX.DUMMY.TOKEN.XXXX";

const siteverifyCalls = (secret: string) => {
  const url = new URL("https://siteverify.test/__calls");
  url.searchParams.set("secret", secret);
  return Effect.promise(() => env.SITEVERIFY_FIXTURE.fetch(url)).pipe(Effect.flatMap(json));
};

const storedKeys = (publicId: string) =>
  Effect.promise(() =>
    env.DB.prepare(
      "SELECT turnstile_site_key AS siteKey, turnstile_secret AS secret FROM forms WHERE public_id = ?",
    )
      .bind(publicId)
      .first(),
  );

it.live("encrypts the Turnstile secret and returns only the site key in form settings", () =>
  Effect.gen(function* () {
    const headers = yield* signIn;
    const { path, form } = yield* formFor("Turnstile configuration", headers);
    const secretKey = "workerd-fixture-secret-config";

    const enabled = yield* call("PUT", path, { siteKey, secretKey }, headers);

    assert.strictEqual(enabled.status, 200);
    const checks = yield* siteverifyCalls(secretKey);
    assert.deepEqual(checks, [{ secret: secretKey, token: dummyToken }]);
    const body = yield* json(enabled);
    assert.notProperty(body, "secretKey");
    assert.strictEqual((yield* readForm(body)).turnstileSiteKey, siteKey);
    const encrypted = yield* Effect.promise(() =>
      env.DB.prepare("SELECT turnstile_secret FROM forms WHERE public_id = ?")
        .bind(form.publicId)
        .first<string>("turnstile_secret"),
    );
    if (encrypted === null) return assert.fail("Expected the encrypted Turnstile secret");
    assert.match(encrypted, /^v1\.[^.]+\.[^.]+$/u);
    assert.notInclude(encrypted, secretKey);
    const listed = yield* call("GET", "/api/organizations", undefined, headers);
    const listing = yield* Effect.promise(() => listed.text());
    assert.notInclude(listing, secretKey);
    assert.notInclude(listing, encrypted);

    const disabled = yield* call("DELETE", path, undefined, headers);
    assert.strictEqual(disabled.status, 200);
    assert.isNull((yield* json(disabled).pipe(Effect.flatMap(readForm))).turnstileSiteKey);
  }),
);

it.live(
  "refuses Turnstile activation with the webhook error when the encryption key is missing",
  () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const { path } = yield* formFor("Turnstile without encryption", headers);
      const response = yield* Effect.promise(() =>
        env.KEYLESS_WORKER.fetch(new URL(path, testOrigin), {
          method: "PUT",
          headers: { ...headers, origin: testOrigin, "content-type": "application/json" },
          body: '{"siteKey":"sample-site-key","secretKey":"test-keyless-secret"}',
        }),
      );
      assert.strictEqual(response.status, 503);
      const body = yield* json(response);
      assert.deepEqual(body, { error: "secrets-key-missing" });
    }),
);

const refusals = [
  {
    outcome: "refuses",
    secretKey: "refused-new-key",
    status: 400,
    error: "turnstile-secret-refused",
  },
  {
    outcome: "cannot be reached for",
    secretKey: "unreachable-new-key",
    status: 503,
    error: "siteverify-unavailable",
  },
  {
    outcome: "reports an internal error for",
    secretKey: "internal-error-new-key",
    status: 503,
    error: "siteverify-unavailable",
  },
] as const;

for (const { outcome, secretKey, status, error } of refusals) {
  it.live(`keeps the current Turnstile keys when Siteverify ${outcome} a new secret key`, () =>
    Effect.gen(function* () {
      const headers = yield* signIn;
      const { path, form } = yield* formFor(`Turnstile key that Siteverify ${outcome}`, headers);
      const configured = yield* call(
        "PUT",
        path,
        { siteKey, secretKey: `known-before-${secretKey}` },
        headers,
      );
      assert.strictEqual(configured.status, 200);
      const before = yield* storedKeys(form.publicId);

      const replaced = yield* call(
        "PUT",
        path,
        { siteKey: "replacement_site_key", secretKey },
        headers,
      );

      assert.strictEqual(replaced.status, status);
      const body = yield* json(replaced);
      assert.deepEqual(body, { error });
      const after = yield* storedKeys(form.publicId);
      assert.deepEqual(after, before);
      const checks = yield* siteverifyCalls(secretKey);
      assert.deepEqual(checks, [{ secret: secretKey, token: dummyToken }]);
    }),
  );
}

const cases = [
  { name: "valid", token: "valid-siteverify-valid", classified: true },
  { name: "missing", token: null, classified: false },
  { name: "refused", token: "wrong", classified: false },
  { name: "400-refused", token: "refused-with-400", classified: false },
  { name: "unavailable", token: "unavailable", classified: true },
  { name: "secret-unknown", token: "secret-unknown", classified: true },
  { name: "timeout", token: "slow", classified: true },
] as const;

for (const { name, token, classified } of cases) {
  it.live(
    `handles a ${name} Turnstile check before classification`,
    () =>
      Effect.gen(function* () {
        const headers = yield* signIn;
        const { path, organization, form } = yield* formFor(`Turnstile ${name}`, headers);
        const secretKey = `siteverify-${name}`;
        const configured = yield* call("PUT", path, { siteKey, secretKey }, headers);
        assert.strictEqual(configured.status, 200);
        const fields = { message: `Turnstile ${name} inquiry`, "fixture-verdict": "accept" };
        const payload = token === null ? fields : { ...fields, [turnstileField]: token };

        const received = yield* call("POST", `/f/${form.publicId}`, payload);

        assert.strictEqual(received.status, 202);
        const { "submission-id": id } = yield* json(received).pipe(Effect.flatMap(readAccepted));
        const detail = yield* Effect.promise(() =>
          vi.waitFor(
            () =>
              env.TEST_WORKER.fetch(
                new URL(`/api/organizations/${organization.id}/submissions/${id}`, testOrigin),
                { headers },
              )
                .then((response) => response.json())
                .then(readDetail)
                .then((current) => {
                  assert.strictEqual(current.status, classified ? "accepted" : "quarantined");
                  return current;
                }),
            { timeout: 15_000, interval: 100 },
          ),
        );
        assert.strictEqual(detail.reason, classified ? null : "turnstile-failed");
        assert.deepEqual(detail.fields, fields);
        const keyCheck = { secret: secretKey, token: dummyToken };
        const checks = yield* siteverifyCalls(secretKey);
        assert.deepEqual(
          checks,
          token === null ? [keyCheck] : [keyCheck, { secret: secretKey, token }],
        );
        const ai = yield* Effect.promise(() =>
          env.WORKERS_AI_FIXTURE.fetch("https://workers-ai.test/__calls"),
        );
        const calls = yield* json(ai).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
            ),
          ),
        );
        assert.deepEqual(
          calls.filter((entry) => entry?.message === fields.message),
          classified ? [fields] : [],
        );
      }),
    30_000,
  );
}
