import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Clock, Context, DateTime, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import { verifyRondyrWebhook } from "../../docs/examples/verify-webhook.ts";
import guide from "../../docs/webhooks.md?raw";
import { testSecretsKey } from "../../tests/integration/auth-fixture.ts";
import { secretCipherLayer } from "../adapters/crypto/secret-cipher.ts";
import { deliveryStoreLive } from "../adapters/database/delivery-store.ts";
import { notificationTargetsLive } from "../adapters/database/notification-targets.ts";
import { emailSenderLayer } from "../adapters/email/email-sender.ts";
import { recipientConfirmationsLive } from "../adapters/database/recipient-confirmations.ts";
import { notificationProvidersLive } from "../adapters/notifications/notification-providers.ts";
import { DeliveryId, DeliveryStatus } from "../domain/deliveries/delivery.ts";
import { parseWebhookUrl, type WebhookUrl } from "../domain/deliveries/webhook-destination.ts";
import { WebhookPayload } from "../domain/deliveries/webhook.ts";
import { DeliveryScheduler } from "../domain/submissions/delivery-scheduler.external.ts";
import { SubmissionFields } from "../domain/submissions/submission-fields.ts";
import { OrganizationId, SubmissionId, UserId } from "../domain/submissions/submission.id.ts";
import { DeliveryQueue } from "../ports/delivery-queue.ts";
import { NotificationTargets, type FormScope } from "../ports/notification-targets.ts";
import {
  consumeDeliveries,
  deliverySchedulerLive,
  publishPendingDeliveries,
} from "./delivery-outbox.ts";

const contact = { email: "customer@example.test", message: "Is there room in the pottery class?" };

const Received = Schema.Struct({
  url: Schema.String,
  path: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
});
type Received = typeof Received.Type;
const DeliveryRow = Schema.Struct({
  id: DeliveryId,
  status: DeliveryStatus,
  attempt_count: Schema.Int,
  last_error: Schema.NullOr(Schema.String),
});
const readReceived = Schema.decodeUnknownEffect(Schema.Array(Received));
const readDeliveries = Schema.decodeUnknownEffect(Schema.Array(DeliveryRow));
const readPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(WebhookPayload));
const readJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const encodeFields = Schema.encodeEffect(Schema.fromJsonString(SubmissionFields));

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const keyOf = (key: string) => Effect.succeedSome(Redacted.make(key));
const cipher = secretCipherLayer(keyOf(testSecretsKey));
// Another valid key: a secret sealed with it does not open with the test key.
const otherCipher = secretCipherLayer(keyOf("b3RoZXItd29ya2VyZC10ZXN0LW9ubHkta2V5LTMyYnk="));
const noEmail = emailSenderLayer(Effect.succeed({})).pipe(Layer.provide(FetchHttpClient.layer));

/** Every request goes to the receiver fixture through its service binding, whatever the host. */
const receiverFetch: typeof globalThis.fetch = (input, init) =>
  env.WEBHOOK_RECEIVER.fetch(input, init);

function services() {
  const sent: Array<DeliveryId> = [];
  const queue = Layer.succeed(DeliveryQueue, {
    send: (deliveryIds) =>
      Effect.sync(() => {
        sent.push(...deliveryIds);
      }),
  });
  const stored = Layer.mergeAll(deliveryStoreLive, queue);
  const layer = Layer.mergeAll(
    stored,
    deliverySchedulerLive.pipe(Layer.provide(stored)),
    Layer.mergeAll(notificationProvidersLive, notificationTargetsLive).pipe(
      Layer.provide(Layer.mergeAll(cipher, noEmail, recipientConfirmationsLive)),
    ),
    Layer.succeed(FetchHttpClient.Fetch, receiverFetch),
  );
  return { sent, layer };
}

const withServices = <A, E, R>(layer: Layer.Layer<R>, scenario: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Layer.build(layer), (built) => Effect.provideContext(scenario, built));

/** A member of `<name>-org`, whose form `<name>` has one submission received at `receivedAt`. */
const seedForm = Effect.fnUntraced(function* (name: string, submissionIds: ReadonlyArray<string>) {
  const fields = yield* encodeFields(contact);
  yield* Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auth_users (id, name, email, created_at, updated_at) VALUES (?1, ?1, ?2, 0, 0)",
      ).bind(`${name}-user`, `${name}@example.test`),
      env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(
        `${name}-org`,
        name,
      ),
      env.DB.prepare(
        "INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'admin')",
      ).bind(`${name}-org`, `${name}-user`),
      env.DB.prepare(
        "INSERT INTO forms (id, organization_id, public_id, name) VALUES (?, ?, ?, ?)",
      ).bind(`${name}-form`, `${name}-org`, name, `Form ${name}`),
      ...submissionIds.map((id, index) =>
        env.DB.prepare(
          "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(id, `${name}-org`, `${name}-form`, fields, index * 1000),
      ),
    ]),
  );
  const scope: FormScope = {
    userId: UserId.make(`${name}-user`),
    organizationId: OrganizationId.make(`${name}-org`),
    formPublicId: name,
  };
  return scope;
});

const webhookUrl = (url: string): WebhookUrl =>
  Result.match(parseWebhookUrl(url, Option.none()), {
    onSuccess: (accepted) => accepted,
    onFailure: (reason) => assert.fail(`${url} is refused: ${reason}`),
  });

/** Run the `Delivery` policy's scheduler for an acceptance now. */
const deliverAccepted = Effect.fnUntraced(function* (form: FormScope, submissionId: SubmissionId) {
  const scheduler = yield* DeliveryScheduler;
  const acceptedAt = yield* Clock.currentTimeMillis;
  yield* scheduler.schedule({ submissionId, organizationId: form.organizationId, acceptedAt });
});

const deliveriesOf = Effect.fnUntraced(function* (submissionId: string) {
  const rows = yield* Effect.promise(() =>
    env.DB.prepare(
      "SELECT id, status, attempt_count, last_error FROM deliveries WHERE submission_id = ? ORDER BY target_id",
    )
      .bind(submissionId)
      .all(),
  );
  return yield* readDeliveries(rows.results);
});

/** Run the consumer once for every delivery of the submission. */
const consume = Effect.fnUntraced(function* (submissionId: string) {
  const rows = yield* deliveriesOf(submissionId);
  const messages = rows.map(({ id }, index): Message => ({
    id: `message-${index}`,
    timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    attempts: 1,
    body: { deliveryId: id },
    ack: () => {},
    retry: () => {},
  }));
  yield* consumeDeliveries({
    queue: "rondyr-delivery",
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => {},
    retryAll: () => {},
  });
  return yield* deliveriesOf(submissionId);
});

const receivedUnder = Effect.fnUntraced(function* (prefix: string) {
  const response = yield* Effect.promise(() =>
    env.WEBHOOK_RECEIVER.fetch(
      `https://receiver.test/__received?prefix=${encodeURIComponent(prefix)}`,
    ),
  );
  const json = yield* Effect.promise(() => response.json());
  return yield* readReceived(json);
});

/** Rebuild the recorded request and check it with the example in docs/webhooks.md. */
function verify(received: Received, secret: string, now: number, body = received.body) {
  const request = new Request(received.url, {
    method: received.method,
    headers: received.headers,
    body,
  });
  return Effect.promise(() => verifyRondyrWebhook(request, secret, now));
}

it.effect("signs the request so that the documented example verifies it", () => {
  const { layer } = services();
  const submissionId = SubmissionId.make("5a0c1d2e-3f40-4152-8a6b-7c8d9e0f1a01");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("signed", [submissionId]);
    const targets = yield* NotificationTargets;
    const issued = yield* targets.createWebhook(
      form,
      webhookUrl("https://hooks.example.com/t/signed/ok"),
    );
    assert.match(issued.secret, /^whsec_[A-Za-z0-9_-]{43}$/u);
    const stored = yield* Effect.promise(() =>
      env.DB.prepare("SELECT configuration FROM notification_targets WHERE id = ?")
        .bind(issued.target.id)
        .first("configuration"),
    );
    assert.notInclude(String(stored), issued.secret.slice("whsec_".length));

    yield* deliverAccepted(form, submissionId);
    const [row] = yield* consume(submissionId);
    assert.deepEqual([row?.status, row?.attempt_count, row?.last_error], ["delivered", 1, null]);

    const [request, ...others] = yield* receivedUnder("/t/signed/");
    if (request === undefined) return assert.fail("The receiver got no request");
    assert.deepEqual(others, []);
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(request.headers["content-type"], "application/json");
    assert.strictEqual(request.headers["rondyr-delivery-id"], row?.id);
    assert.strictEqual(request.headers["rondyr-timestamp"], "0");
    assert.match(request.headers["rondyr-signature"] ?? "", /^v1=[0-9a-f]{64}$/u);
    assert.notProperty(request.headers, "traceparent");

    // The wire format of version 1, as docs/webhooks.md describes it.
    const json = yield* readJson(request.body);
    assert.deepEqual(json, {
      version: 1,
      type: "submission.accepted",
      deliveryId: row?.id ?? "",
      submission: { id: submissionId, receivedAt: "1970-01-01T00:00:00.000Z", fields: contact },
      form: { id: "signed", name: "Form signed" },
    });
    yield* readPayload(request.body);

    const tampered = request.body.replace("pottery", "Pottery");
    const checks = yield* Effect.all([
      verify(request, issued.secret, 0),
      verify(request, issued.secret, 299_000),
      // Expired, checked with another secret, or with a changed body.
      verify(request, issued.secret, 301_000),
      verify(request, `${issued.secret}x`, 0),
      verify(request, issued.secret, 0, tampered),
    ]);
    assert.deepEqual(checks, [request.body, request.body, null, null, null]);
  });
  return withServices(layer, scenario);
});

it.effect("sends a retry with the same delivery id after a 500, then delivers", () => {
  const { layer } = services();
  const submissionId = SubmissionId.make("5a0c1d2e-3f40-4152-8a6b-7c8d9e0f1a02");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("flaky", [submissionId]);
    const targets = yield* NotificationTargets;
    const issued = yield* targets.createWebhook(
      form,
      webhookUrl("https://hooks.example.com/t/flaky/fail-once"),
    );
    yield* deliverAccepted(form, submissionId);
    const [first] = yield* consume(submissionId);
    // Only the status reaches the summary, not the body of the response.
    assert.deepEqual(
      [first?.status, first?.last_error],
      ["retrying", "The recipient answered HTTP 500."],
    );

    yield* TestClock.adjust("1 minute");
    const [second] = yield* consume(submissionId);
    assert.deepEqual([second?.status, second?.attempt_count], ["delivered", 2]);

    const requests = yield* receivedUnder("/t/flaky/");
    assert.deepEqual(
      requests.map(({ headers }) => [headers["rondyr-delivery-id"], headers["rondyr-timestamp"]]),
      [
        [first?.id, "0"],
        [first?.id, "60"],
      ],
    );
    const [, retry] = requests;
    if (retry === undefined) return assert.fail("The retry did not reach the receiver");
    const verified = yield* verify(retry, issued.secret, 60_000);
    assert.strictEqual(verified, retry.body);
  });
  return withServices(layer, scenario);
});

it.effect("ends the delivery on a 400 or a redirect, without a retry", () => {
  const { layer, sent } = services();
  const refusedId = SubmissionId.make("5a0c1d2e-3f40-4152-8a6b-7c8d9e0f1a03");
  const redirectedId = SubmissionId.make("5a0c1d2e-3f40-4152-8a6b-7c8d9e0f1a04");
  const scenario = Effect.gen(function* () {
    const refusing = yield* seedForm("refusing", [refusedId]);
    const redirecting = yield* seedForm("redirecting", [redirectedId]);
    const targets = yield* NotificationTargets;
    yield* targets.createWebhook(
      refusing,
      webhookUrl("https://hooks.example.com/t/refusing/bad-request"),
    );
    yield* targets.createWebhook(
      redirecting,
      webhookUrl("https://hooks.example.com/t/redirecting/redirect"),
    );
    yield* deliverAccepted(refusing, refusedId);
    yield* deliverAccepted(redirecting, redirectedId);

    const [refused] = yield* consume(refusedId);
    const [redirected] = yield* consume(redirectedId);
    assert.deepEqual(
      [refused?.status, refused?.attempt_count, refused?.last_error],
      ["failed", 1, "The recipient answered HTTP 400."],
    );
    assert.deepEqual(
      [redirected?.status, redirected?.attempt_count, redirected?.last_error],
      ["failed", 1, "The recipient answered HTTP 307. Redirects are not followed."],
    );
    // The Location of the redirect is never requested.
    const requests = yield* receivedUnder("/t/redirecting/");
    assert.deepEqual(
      requests.map(({ path }) => path),
      ["/t/redirecting/redirect"],
    );

    sent.length = 0;
    yield* TestClock.adjust("1 day");
    yield* publishPendingDeliveries();
    assert.deepEqual(sent, []);
    const refusedRequests = yield* receivedUnder("/t/refusing/");
    assert.strictEqual(refusedRequests.length, 1);
  });
  return withServices(layer, scenario);
});

it.effect("checks the stored URL and secret again before each send", () => {
  const { layer } = services();
  const submissionId = SubmissionId.make("5a0c1d2e-3f40-4152-8a6b-7c8d9e0f1a05");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("stale", [submissionId]);
    const targets = yield* NotificationTargets;
    const moved = yield* targets.createWebhook(
      form,
      webhookUrl("https://hooks.example.com/t/stale/moved/ok"),
    );
    // A row written before this rule existed, or by hand, with a private address.
    yield* Effect.promise(() =>
      env.DB.prepare(
        "UPDATE notification_targets SET configuration = json_set(configuration, '$.url', 'https://10.0.0.1/t/stale/moved/ok') WHERE id = ?",
      )
        .bind(moved.target.id)
        .run(),
    );
    // A secret sealed under another RONDYR_SECRETS_KEY.
    // Fresh, because the services of this test already built the layer with the test key.
    const foreign = Layer.fresh(
      notificationTargetsLive.pipe(Layer.provide(Layer.mergeAll(otherCipher, noEmail))),
    );
    const foreignTargets = yield* Effect.scoped(
      Effect.map(Layer.build(foreign), (built) => Context.get(built, NotificationTargets)),
    );
    yield* foreignTargets.createWebhook(
      form,
      webhookUrl("https://hooks.example.com/t/stale/rekeyed/ok"),
    );

    yield* deliverAccepted(form, submissionId);
    const rows = yield* consume(submissionId);
    assert.sameDeepMembers(
      rows.map(({ status, last_error }) => [status, last_error]),
      [
        ["failed", "The webhook URL is refused: reserved-address."],
        ["failed", "The signing secret of this webhook target cannot be decrypted."],
      ],
    );
    const requests = yield* receivedUnder("/t/stale/");
    assert.deepEqual(requests, []);
  });
  return withServices(layer, scenario);
});

it.effect("signs with both secrets during the rotation window, then with the new one", () => {
  const { layer } = services();
  const during = SubmissionId.make("5a0c1d2e-3f40-4152-8a6b-7c8d9e0f1a06");
  const after = SubmissionId.make("5a0c1d2e-3f40-4152-8a6b-7c8d9e0f1a07");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("rotation", [during, after]);
    const targets = yield* NotificationTargets;
    const created = yield* targets.createWebhook(
      form,
      webhookUrl("https://hooks.example.com/t/rotation/ok"),
    );
    yield* TestClock.adjust("1 hour");
    const rotated = yield* targets.rotateSecret({
      userId: form.userId,
      organizationId: form.organizationId,
      targetId: created.target.id,
    });
    assert.notStrictEqual(rotated.secret, created.secret);
    assert.strictEqual(rotated.target.previousSecretExpiresAt, 3_600_000 + 86_400_000);
    const listed = yield* targets.list(form);
    assert.deepEqual(listed, [rotated.target]);

    yield* deliverAccepted(form, during);
    yield* consume(during);
    yield* TestClock.adjust("24 hours");
    yield* deliverAccepted(form, after);
    yield* consume(after);

    const [first, second] = yield* receivedUnder("/t/rotation/");
    if (first === undefined || second === undefined) return assert.fail("Two requests expected");
    assert.match(first.headers["rondyr-signature"] ?? "", /^v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/u);
    assert.match(second.headers["rondyr-signature"] ?? "", /^v1=[0-9a-f]{64}$/u);
    const firstAt = 3_600_000;
    const secondAt = firstAt + 86_400_000;
    const checks = yield* Effect.all([
      verify(first, created.secret, firstAt),
      verify(first, rotated.secret, firstAt),
      verify(second, rotated.secret, secondAt),
      verify(second, created.secret, secondAt),
    ]);
    assert.deepEqual(checks, [first.body, first.body, second.body, null]);
  });
  return withServices(layer, scenario);
});

// The ?raw source of the example, as text rather than as a module.
const examples = import.meta.glob<string>("../../docs/examples/verify-webhook.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

it("documents the same verification example that these tests run", () => {
  const [source, ...others] = Object.values(examples);
  assert.deepEqual(others, []);
  assert.include(guide, source ?? assert.fail("docs/examples/verify-webhook.ts is missing"));
});
