import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Clock, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { verifyRondyrWebhook } from "../../../../docs/examples/verify-webhook.ts";
import {
  testEmailFrom,
  testOrigin as origin,
  testResendKey,
  testSetupToken,
} from "../../tests/integration/auth-fixture.ts";
import { confirmByEmail } from "../../tests/integration/recipient-fixture.ts";
import { secretCipherLive } from "../adapters/crypto/secret-cipher.ts";
import { notificationTargetsLive } from "../adapters/database/notification-targets.ts";
import { recipientConfirmationsLive } from "../adapters/database/recipient-confirmations.ts";
import { organizationDirectoryLive } from "../adapters/database/organization-directory.ts";
import { emailSenderLive } from "../adapters/email/email-sender.ts";
import { EmailTarget, type RecipientsRefusalReason } from "../domain/deliveries/email.ts";
import { DestinationTarget, TargetRequestError } from "../domain/deliveries/targets.ts";
import type { DestinationRefusalReason } from "../domain/deliveries/webhook-destination.ts";
import { IssuedWebhookSecret, WebhookTarget } from "../domain/deliveries/webhook.ts";
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
const readDestinations = Schema.decodeUnknownEffect(Schema.Array(DestinationTarget));
const readEmailTarget = Schema.decodeUnknownEffect(EmailTarget);
const readDestination = Schema.decodeUnknownEffect(DestinationTarget);
const ResendEmail = Schema.Struct({
  from: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
  reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
});
const readResendEmail = Schema.decodeUnknownEffect(Schema.fromJsonString(ResendEmail));
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

const post = Effect.fnUntraced(function* (
  path: string,
  data: Schema.Json,
  extra?: HeadersInit,
  worker: Fetcher = env.TEST_WORKER,
) {
  const body = yield* encode(data);
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("origin", origin);
  return yield* Effect.promise(() =>
    worker.fetch(new URL(path, origin), { method: "POST", headers, body }),
  );
});

const json = (response: Response) => Effect.promise(() => response.json());

const put = Effect.fnUntraced(function* (path: string, data: Schema.Json, extra?: HeadersInit) {
  const body = yield* encode(data);
  const headers = new Headers(extra);
  headers.set("content-type", "application/json");
  headers.set("origin", origin);
  return yield* request(path, { method: "PUT", headers, body });
});

/** Status and JSON body of each response. */
const answers = (responses: ReadonlyArray<Response>) =>
  Effect.forEach(responses, (response) =>
    Effect.map(json(response), (body) => ({ status: response.status, body })),
  );

const statusOf = (response: Response) => response.status;

it.live(
  "manages the webhook and email targets of the account's forms and delivers through the deployed Worker",
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

      // Email targets: each address is a bare address, with no display name or line break.
      const refusedRecipients: ReadonlyArray<
        readonly [ReadonlyArray<string>, RecipientsRefusalReason]
      > = [
        [[], "no-recipients"],
        [["Potter <potter@example.test>"], "invalid-address"],
        [["potter@example.test\r\nBcc: victim@example.test"], "invalid-address"],
        [["potter@example.test, victim@example.test"], "invalid-address"],
        [
          Array.from({ length: 11 }, (_, index) => `team-${index}@example.test`),
          "too-many-recipients",
        ],
        [["Team@example.test", "team@example.test"], "duplicate-address"],
      ];
      const recipientRefusals = yield* Effect.forEach(refusedRecipients, ([recipients]) =>
        post(formTargets, { type: "email", recipients }, headers),
      ).pipe(Effect.flatMap(answers));
      assert.deepEqual(
        recipientRefusals,
        refusedRecipients.map(([, reason]) => ({
          status: 400,
          body: { error: "recipients-refused", reason },
        })),
      );
      const createdEmail = yield* post(
        formTargets,
        { type: "email", recipients: ["routes-team@example.test"] },
        headers,
      );
      assert.strictEqual(createdEmail.status, 201);
      const email = yield* json(createdEmail).pipe(Effect.flatMap(readEmailTarget));
      assert.deepEqual([email.recipients, email.active], [["routes-team@example.test"], true]);
      // A request that names no language gets a target in English.
      assert.strictEqual(email.language, "en");
      const both = yield* request(formTargets, { headers }).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readDestinations),
      );
      assert.deepEqual(both, [reactivated, email]);

      const emailTarget = `/api/organizations/${inbox.id}/targets/${email.id}`;
      const recipients = ["routes-team@example.test", "routes-owner@example.test"];
      const replaced = yield* put(`${emailTarget}/recipients`, { recipients }, headers).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readEmailTarget),
      );
      assert.deepEqual([...replaced.recipients], recipients);
      assert.deepEqual(
        replaced.recipientStatuses.map(({ status }) => status),
        ["pending", "pending"],
      );
      // Each owner confirms with the link of the email that the creation and the edit sent.
      yield* confirmByEmail("routes-team@example.test");
      yield* confirmByEmail("routes-owner@example.test");
      const replaceRefused = yield* Effect.all([
        put(`${emailTarget}/recipients`, { recipients: ["Owner <owner@example.test>"] }, headers),
        put(`${emailTarget}/recipients`, { recipients: [] }, headers),
      ]).pipe(Effect.flatMap(answers));
      assert.deepEqual(replaceRefused, [
        { status: 400, body: { error: "recipients-refused", reason: "invalid-address" } },
        { status: 400, body: { error: "recipients-refused", reason: "no-recipients" } },
      ]);
      // A webhook has no recipients.
      const notEmail = yield* put(`${target}/recipients`, { recipients }, headers);
      assert.strictEqual(notEmail.status, 404);
      const emailOff = yield* post(`${emailTarget}/deactivate`, {}, headers).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readDestination),
      );
      assert.deepEqual([emailOff.type, emailOff.active], ["email", false]);
      const emailOn = yield* post(`${emailTarget}/activate`, {}, headers).pipe(
        Effect.flatMap(json),
        Effect.flatMap(readDestination),
      );
      assert.deepEqual(emailOn, {
        ...replaced,
        active: true,
        recipientStatuses: replaced.recipientStatuses.map(({ address }) => ({
          address,
          status: "confirmed" as const,
        })),
      });

      // The deployed composition sends the next accepted message through Resend.
      const mailed = yield* post(`/f/${form.publicId}`, {
        ...contact,
        "fixture-verdict": "accept",
      });
      assert.strictEqual(mailed.status, 202);
      const sent = yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.RESEND_FIXTURE.fetch(
              "https://api.resend.com/__received?recipient=routes-team@example.test",
            )
              .then((response) => response.json())
              .then((body) => {
                // The confirmation emails came first; one delivery email follows them.
                const messages = Array.isArray(body)
                  ? body.filter((entry) => entry.body.includes('"subject":"New message'))
                  : [];
                assert.lengthOf(messages, 1);
                return messages;
              }),
          { timeout: 20_000, interval: 100 },
        ),
      );
      const [resend] = yield* readReceived(sent);
      if (resend === undefined) return assert.fail("Expected a Resend request");
      assert.strictEqual(resend.headers["authorization"], `Bearer ${testResendKey}`);
      assert.match(resend.headers["idempotency-key"] ?? "", /^[0-9a-f-]{36}$/u);
      const message = yield* readResendEmail(resend.body);
      assert.deepEqual(
        [message.from, message.to, message.subject, message.reply_to],
        [testEmailFrom, recipients, "New message: Classes", [contact.email]],
      );
      assert.include(message.text, contact.message);

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

      // The same for email targets: listing, creating, editing and deactivating.
      const farawayRecipients = '{"recipients":["faraway@example.test"]}';
      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('faraway-org', 'Far')"),
          env.DB.prepare(
            "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('faraway-form', 'faraway-org', 'faraway', 'Far')",
          ),
          env.DB.prepare(`
            INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
            VALUES ('faraway-email', 'faraway-org', 'faraway-form', 'email', ?, 0)
          `).bind(farawayRecipients),
        ]),
      );
      const farForm = "/api/organizations/faraway-org/forms/faraway/targets";
      const farTarget = "/api/organizations/faraway-org/targets/faraway-email";
      const mixedEmail = `/api/organizations/${inbox.id}/targets/faraway-email`;
      const mixedFarForm = `/api/organizations/${inbox.id}/forms/faraway/targets`;
      const mail = { type: "email", recipients: ["intruder@example.test"] };
      const edit = { recipients: ["intruder@example.test"] };
      const farAway = yield* Effect.all([
        request(farForm, { headers }),
        post(farForm, mail, headers),
        post(mixedFarForm, mail, headers),
        put(`${farTarget}/recipients`, edit, headers),
        post(`${farTarget}/deactivate`, {}, headers),
        put(`${mixedEmail}/recipients`, edit, headers),
        post(`${mixedEmail}/deactivate`, {}, headers),
      ]);
      assert.deepEqual(farAway.map(statusOf), [404, 404, 404, 404, 404, 404, 404]);
      const farUntouched = yield* Effect.promise(() =>
        env.DB.prepare(
          "SELECT COUNT(*) AS targets, MAX(active) AS active, MAX(configuration) AS configuration FROM notification_targets WHERE organization_id = 'faraway-org'",
        ).first(),
      );
      assert.deepEqual(farUntouched, { targets: 1, active: 1, configuration: farawayRecipients });
    }),
  // Two messages go through classification and delivery in the deployed Worker.
  45_000,
);

it.live("refuses to create an email target when the stage has no email provider", () =>
  Effect.gen(function* () {
    // This test Worker has no RESEND_API_KEY nor RONDYR_EMAIL_FROM.
    const configuration = '{"recipients":["owner@example.test"]}';
    yield* Effect.promise(() =>
      env.DB.batch([
        env.DB.prepare(
          "INSERT INTO auth_users (id, name, email, created_at, updated_at) VALUES ('mailless-user', 'Mailless', 'mailless@example.test', 0, 0)",
        ),
        env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('mailless-org', 'Mailless')"),
        env.DB.prepare(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ('mailless-org', 'mailless-user', 'admin')",
        ),
        env.DB.prepare(
          "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('mailless-form', 'mailless-org', 'mailless', 'Mailless')",
        ),
        env.DB.prepare(
          "INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at) VALUES ('mailless-email', 'mailless-org', 'mailless-form', 'email', ?, 0)",
        ).bind(configuration),
      ]),
    );
    const member = Layer.succeed(Authentication, {
      userId: () => Effect.succeed("mailless-user"),
      handle: () => Effect.die("The routes under test do not proxy Better Auth"),
      setup: () => Effect.die("The routes under test do not create accounts"),
      setupState: Effect.die("The routes under test do not read the setup state"),
    });
    const services = yield* Layer.build(
      Layer.mergeAll(
        member,
        organizationDirectoryLive,
        notificationTargetsLive.pipe(
          Layer.provide(Layer.mergeAll(secretCipherLive, emailSenderLive)),
        ),
        emailSenderLive,
        recipientConfirmationsLive,
      ),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(
      targetRoutes.pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );
    const call = (path: string, method = "GET", body?: string) =>
      Effect.promise(() =>
        handler(
          new Request(new URL(`/api/organizations/mailless-org${path}`, origin), {
            method,
            headers: { "content-type": "application/json", origin },
            body: body ?? null,
          }),
          services,
        ),
      );

    const createBody = yield* encode({ type: "email", recipients: ["team@example.test"] });
    const refused = yield* call("/forms/mailless/targets", "POST", createBody);
    const error = yield* json(refused).pipe(Effect.flatMap(readError));
    assert.deepEqual([refused.status, error], [503, { error: "email-provider-missing" }]);

    // Listing, editing and deactivation need no provider.
    const listed = yield* call("/forms/mailless/targets").pipe(
      Effect.flatMap(json),
      Effect.flatMap(readDestinations),
    );
    assert.deepEqual(
      listed.map(({ id, type }) => [id, type]),
      [["mailless-email", "email"]],
    );
    const editBody = yield* encode({ recipients: ["team@example.test"] });
    const edited = yield* call("/targets/mailless-email/recipients", "PUT", editBody);
    const deactivated = yield* call("/targets/mailless-email/deactivate", "POST");
    assert.deepEqual([edited.status, deactivated.status], [200, 200]);
    const rows = yield* Effect.promise(() =>
      env.DB.prepare(
        "SELECT id, configuration, active FROM notification_targets WHERE organization_id = 'mailless-org'",
      ).all(),
    );
    assert.deepEqual(rows.results, [
      { id: "mailless-email", configuration: '{"recipients":["team@example.test"]}', active: 0 },
    ]);
    yield* Effect.promise(dispose);
  }).pipe(Effect.scoped),
);

it.live("sends a test email through the built Worker configured for Cloudflare", () =>
  Effect.gen(function* () {
    yield* Effect.promise(() => applyD1Migrations(env.CLOUDFLARE_EMAIL_DB, env.TEST_MIGRATIONS));
    const worker = env.CLOUDFLARE_EMAIL_WORKER;
    const credentials = {
      email: "cloudflare-owner@example.test",
      password: "cloudflare-test-password",
    };
    const setup = yield* post(
      "/api/setup",
      { name: "Potter", ...credentials },
      { authorization: `Bearer ${testSetupToken}` },
      worker,
    );
    assert.strictEqual(setup.status, 201);
    const signIn = yield* post("/api/auth/sign-in/email", credentials, undefined, worker);
    assert.strictEqual(signIn.status, 200);
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const headers = { cookie, origin };
    const created = yield* post(
      "/api/organizations",
      { organizationName: "Cloudflare studio", formName: "Classes", businessContext: "" },
      headers,
      worker,
    );
    assert.strictEqual(created.status, 201);
    const inboxes = yield* Effect.promise(() =>
      worker.fetch(new URL("/api/organizations", origin), { headers }),
    ).pipe(Effect.flatMap(json), Effect.flatMap(readInboxes));
    const [inbox] = inboxes;
    const form = inbox?.forms[0];
    if (inbox === undefined || form === undefined) return assert.fail("Expected a form");

    const target = yield* post(
      `/api/organizations/${inbox.id}/forms/${form.publicId}/targets`,
      { type: "email", recipients: ["proof@example.test"] },
      headers,
      worker,
    );
    assert.strictEqual(target.status, 201);
    const email = yield* json(target).pipe(Effect.flatMap(readEmailTarget));
    // The owner of the address confirms it with the link of the email that Cloudflare sent.
    const confirmation = yield* Effect.promise(() =>
      env.CLOUDFLARE_EMAIL_FIXTURE.fetch(
        "https://email.test/__received?recipient=proof@example.test",
      ),
    ).pipe(
      Effect.flatMap(json),
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ text: Schema.String }))),
      ),
    );
    const token = /\/confirm-recipient#([A-Za-z0-9_-]{43})/u.exec(confirmation[0]?.text ?? "")?.[1];
    if (token === undefined) return assert.fail("Expected a confirmation link");
    const confirmed = yield* post("/api/recipient-confirmations", { token }, undefined, worker);
    assert.strictEqual(confirmed.status, 204);
    const response = yield* post(
      `/api/organizations/${inbox.id}/targets/${email.id}/test`,
      {},
      headers,
      worker,
    );
    const result = yield* json(response).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({ testId: Schema.String, outcome: Schema.String }),
        ),
      ),
    );
    assert.deepEqual([response.status, result.outcome], [200, "delivered"]);

    const received = yield* Effect.promise(() =>
      env.CLOUDFLARE_EMAIL_FIXTURE.fetch(
        "https://email.test/__received?recipient=proof@example.test",
      ),
    ).pipe(
      Effect.flatMap(json),
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              from: Schema.String,
              to: Schema.Array(Schema.String),
              subject: Schema.String,
              text: Schema.String,
              replyTo: Schema.optionalKey(Schema.String),
            }),
          ),
        ),
      ),
    );
    // The confirmation email, then the test.
    assert.lengthOf(received, 2);
    const [, message] = received;
    if (message === undefined) return assert.fail("Expected a test email");
    assert.deepEqual(
      [message.from, message.to, message.subject, message.replyTo],
      [testEmailFrom, ["proof@example.test"], "Test message: Classes", undefined],
    );
    assert.include(message.text, `Test ID: ${result.testId}`);
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
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES ('keyless-org', 'keyless-user', 'admin')",
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
      setupState: Effect.die("The routes under test do not read the setup state"),
    });
    const services = yield* Layer.build(
      Layer.mergeAll(
        member,
        organizationDirectoryLive,
        notificationTargetsLive.pipe(
          Layer.provide(Layer.mergeAll(secretCipherLive, emailSenderLive)),
        ),
        emailSenderLive,
        recipientConfirmationsLive,
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
