import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { verifyRondyrWebhook } from "../../docs/examples/verify-webhook.ts";
import { testOrigin as origin, testSetupToken } from "../../tests/integration/auth-fixture.ts";
import { secretCipherLive } from "../adapters/crypto/secret-cipher.ts";
import { notificationTargetsLive } from "../adapters/database/notification-targets.ts";
import { organizationDirectoryLive } from "../adapters/database/organization-directory.ts";
import type { DestinationRefusalReason } from "../domain/deliveries/webhook-destination.ts";
import {
  IssuedWebhookSecret,
  TargetRequestError,
  WebhookTarget,
} from "../domain/deliveries/webhook.ts";
import { InboxOrganizationWithForms } from "../domain/submissions/inbox-setup.ts";
import { Authentication } from "../ports/authentication.ts";
import { targetRoutes } from "./target-routes.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const readTargets = Schema.decodeUnknownEffect(Schema.Array(WebhookTarget));
const readTargetsText = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(WebhookTarget)),
);
const readTarget = Schema.decodeUnknownEffect(WebhookTarget);
const readIssued = Schema.decodeUnknownEffect(IssuedWebhookSecret);
const readError = Schema.decodeUnknownEffect(TargetRequestError);
const Received = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
});
const readReceived = Schema.decodeUnknownEffect(Schema.Array(Received));
const contact = { email: "customer@example.test", message: "Is there room in the pottery class?" };

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

it.live(
  "manages the webhook targets of the account's forms and delivers through the deployed Worker",
  () =>
    Effect.gen(function* () {
      const credentials = { email: "potter@example.test", password: "webhook-routes-password" };
      const setup = yield* post(
        "/api/setup",
        { name: "Potter", ...credentials },
        { authorization: `Bearer ${testSetupToken}` },
      );
      assert.strictEqual(setup.status, 201);
      const signIn = yield* post("/api/auth/sign-in/email", credentials);
      assert.strictEqual(signIn.status, 200);
      const cookie = signIn.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const headers = { cookie, origin };
      const created = yield* post(
        "/api/organizations",
        { organizationName: "Pottery studio", formName: "Classes", businessContext: "" },
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
      const formTargets = `/api/organizations/${inbox.id}/forms/${form.publicId}/targets`;

      const anonymous = yield* request(formTargets);
      assert.strictEqual(anonymous.status, 401);
      const empty = yield* request(formTargets, { headers }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readTargets),
      );
      assert.deepEqual(empty, []);

      // Refused at creation, with the reason the dashboard shows.
      const refusedUrls: ReadonlyArray<readonly [string, DestinationRefusalReason]> = [
        ["http://hooks.example.com/hook", "not-https"],
        ["https://user:pass@hooks.example.com/hook", "credentials"],
        ["https://hooks.example.com:8443/hook", "custom-port"],
        ["https://localhost/hook", "local-hostname"],
        ["https://10.0.0.8/hook", "reserved-address"],
        ["https://[::1]/hook", "reserved-address"],
        [`${origin}/api/organizations`, "worker-origin"],
      ];
      const refusals = yield* Effect.forEach(refusedUrls, ([url]) =>
        post(formTargets, { type: "webhook", url }, headers).pipe(
          Effect.flatMap((response) =>
            Effect.map(json(response), (body) => ({ status: response.status, body })),
          ),
        ),
      );
      assert.deepEqual(
        refusals,
        refusedUrls.map(([, reason]) => ({
          status: 400,
          body: { error: "destination-refused", reason },
        })),
      );
      const malformed = yield* post(formTargets, { type: "email", url: "x" }, headers);
      assert.strictEqual(malformed.status, 400);

      const createdTarget = yield* post(
        formTargets,
        { type: "webhook", url: "https://hooks.example.com/t/routes/ok" },
        headers,
      );
      assert.strictEqual(createdTarget.status, 201);
      assert.strictEqual(createdTarget.headers.get("cache-control"), "no-store");
      const issued = yield* json(createdTarget).pipe(Effect.flatMap(readIssued));
      assert.deepEqual(
        [issued.target.url, issued.target.active, issued.target.previousSecretExpiresAt],
        ["https://hooks.example.com/t/routes/ok", true, null],
      );

      // The secret is shown once: the list never contains it.
      const listed = yield* request(formTargets, { headers });
      const listedText = yield* Effect.promise(() => listed.text());
      assert.notInclude(listedText, issued.secret);
      const listedTargets = yield* readTargetsText(listedText);
      assert.deepEqual(listedTargets, [issued.target]);

      // The deployed composition sends the accepted message, signed with that secret.
      const accepted = yield* post(`/f/${form.publicId}`, {
        ...contact,
        "fixture-verdict": "accept",
      });
      assert.strictEqual(accepted.status, 202);
      const received = yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.WEBHOOK_RECEIVER.fetch("https://receiver.test/__received?prefix=/t/routes/")
              .then((response) => response.json())
              .then((body) => {
                assert.isTrue(Array.isArray(body) && body.length === 1);
                return body;
              }),
          { timeout: 20_000, interval: 100 },
        ),
      );
      const [delivered] = yield* readReceived(received);
      if (delivered === undefined) return assert.fail("Expected a webhook request");
      const now = yield* Clock.currentTimeMillis;
      const verified = yield* Effect.promise(() =>
        verifyRondyrWebhook(
          new Request(delivered.url, {
            method: delivered.method,
            headers: delivered.headers,
            body: delivered.body,
          }),
          issued.secret,
          now,
        ),
      );
      assert.strictEqual(verified, delivered.body);
      assert.include(delivered.body, contact.message);

      const target = `/api/organizations/${inbox.id}/targets/${issued.target.id}`;
      const rotation = yield* post(`${target}/rotate-secret`, {}, headers);
      assert.strictEqual(rotation.status, 200);
      assert.strictEqual(rotation.headers.get("cache-control"), "no-store");
      const rotated = yield* json(rotation).pipe(Effect.flatMap(readIssued));
      assert.notStrictEqual(rotated.secret, issued.secret);
      assert.isNumber(rotated.target.previousSecretExpiresAt);

      const deactivated = yield* post(`${target}/deactivate`, {}, headers).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readTarget),
      );
      assert.isFalse(deactivated.active);
      const reactivated = yield* post(`${target}/activate`, {}, headers).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readTarget),
      );
      assert.isTrue(reactivated.active);

      // Another organization's form and target answer 404 and stay unchanged.
      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('elsewhere-org', 'Else')"),
          env.DB.prepare(
            "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('elsewhere-form', 'elsewhere-org', 'elsewhere', 'Else')",
          ),
          env.DB.prepare(`
            INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
            VALUES ('elsewhere-webhook', 'elsewhere-org', 'elsewhere-form', 'webhook',
              '{"url":"https://hooks.example.com/else","secret":"v1.a.b","previousSecret":null}', 0)
          `),
        ]),
      );
      const foreignForm = "/api/organizations/elsewhere-org/forms/elsewhere/targets";
      const foreignTarget = "/api/organizations/elsewhere-org/targets/elsewhere-webhook";
      const mixedTarget = `/api/organizations/${inbox.id}/targets/elsewhere-webhook`;
      const mixedForm = `/api/organizations/${inbox.id}/forms/elsewhere/targets`;
      const hook = { type: "webhook", url: "https://hooks.example.com/t/routes/foreign/ok" };
      const foreign = yield* Effect.all([
        request(foreignForm, { headers }),
        post(foreignForm, hook, headers),
        post(mixedForm, hook, headers),
        post(`${foreignTarget}/rotate-secret`, {}, headers),
        post(`${foreignTarget}/deactivate`, {}, headers),
        post(`${mixedTarget}/rotate-secret`, {}, headers),
        post(`${mixedTarget}/deactivate`, {}, headers),
      ]);
      assert.deepEqual(foreign.map(statusOf), [404, 404, 404, 404, 404, 404, 404]);
      const untouched = yield* Effect.promise(() =>
        env.DB.prepare(
          "SELECT COUNT(*) AS targets, MAX(active) AS active, MAX(configuration) AS configuration FROM notification_targets WHERE organization_id = 'elsewhere-org'",
        ).first(),
      );
      assert.deepEqual(untouched, {
        targets: 1,
        active: 1,
        configuration:
          '{"url":"https://hooks.example.com/else","secret":"v1.a.b","previousSecret":null}',
      });
    }),
);

it.live("refuses to create or rotate a webhook target without RONDYR_SECRETS_KEY", () =>
  Effect.gen(function* () {
    // This test Worker has no RONDYR_SECRETS_KEY, and authentication is replaced by a member.
    const configuration =
      '{"url":"https://hooks.example.com/keyless","secret":"v1.a.b","previousSecret":null}';
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare(
          "INSERT INTO auth_users (id, name, email, created_at, updated_at) VALUES ('keyless-user', 'Keyless', 'keyless@example.test', 0, 0)",
        ),
        env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('keyless-org', 'Keyless')"),
        env.DB.prepare(
          "INSERT INTO organization_members (organization_id, user_id) VALUES ('keyless-org', 'keyless-user')",
        ),
        env.DB.prepare(
          "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('keyless-form', 'keyless-org', 'keyless', 'Keyless')",
        ),
        env.DB.prepare(
          "INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at) VALUES ('keyless-webhook', 'keyless-org', 'keyless-form', 'webhook', ?, 0)",
        ).bind(configuration),
      ]),
    );
    const member = Layer.succeed(Authentication, {
      userId: () => Effect.succeed("keyless-user"),
      handle: () => Effect.die("The routes under test do not proxy Better Auth"),
      setup: () => Effect.die("The routes under test do not create accounts"),
    });
    const services = yield* Layer.build(
      Layer.mergeAll(
        member,
        organizationDirectoryLive,
        notificationTargetsLive.pipe(Layer.provide(secretCipherLive)),
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      targetRoutes.pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );
    const call = (path: string, method = "GET", body?: string) =>
      Effect.promise(() =>
        handler(
          new Request(new URL(`/api/organizations/keyless-org${path}`, origin), {
            method,
            headers: { "content-type": "application/json", origin },
            body: body ?? null,
          }),
          services,
        ),
      );

    const createBody = yield* encode({ type: "webhook", url: "https://hooks.example.com/new" });
    const results = yield* Effect.all([
      call("/forms/keyless/targets", "POST", createBody),
      call("/targets/keyless-webhook/rotate-secret", "POST"),
    ]);
    const errors = yield* Effect.forEach(results, (response) =>
      json(response).pipe(Effect.flatMap(readError)),
    );
    assert.deepEqual(results.map(statusOf), [503, 503]);
    assert.deepEqual(errors, [{ error: "secrets-key-missing" }, { error: "secrets-key-missing" }]);

    // Listing and deactivation need no key.
    const listed = yield* call("/forms/keyless/targets");
    const deactivated = yield* call("/targets/keyless-webhook/deactivate", "POST");
    assert.deepEqual([listed.status, deactivated.status], [200, 200]);
    const rows = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT id, configuration, active FROM notification_targets WHERE organization_id = 'keyless-org'",
      ).all(),
    );
    assert.deepEqual(rows.results, [{ id: "keyless-webhook", configuration, active: 0 }]);
    yield* Effect.promise(dispose);
  }).pipe(Effect.scoped),
);
