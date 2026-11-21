import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Clock, DateTime, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import { testSecretsKey } from "../../tests/integration/auth-fixture.ts";
import { confirmRecipients } from "../../tests/integration/recipient-fixture.ts";
import { secretCipherLayer } from "../adapters/crypto/secret-cipher.ts";
import { deliveryStoreLive } from "../adapters/database/delivery-store.ts";
import { notificationTargetsLive } from "../adapters/database/notification-targets.ts";
import { recipientConfirmationsLive } from "../adapters/database/recipient-confirmations.ts";
import { emailSenderLayer, type EmailEnvironment } from "../adapters/email/email-sender.ts";
import { notificationProvidersLive } from "../adapters/notifications/notification-providers.ts";
import { DeliveryId, DeliveryStatus } from "../domain/deliveries/delivery.ts";
import { EmailAddress, parseEmailRecipients } from "../domain/deliveries/email.ts";
import { parseWebhookUrl } from "../domain/deliveries/webhook-destination.ts";
import { DeliveryScheduler } from "../domain/submissions/delivery-scheduler.external.ts";
import { SubmissionFields } from "../domain/submissions/submission-fields.ts";
import { OrganizationId, SubmissionId, UserId } from "../domain/submissions/submission.id.ts";
import { DeliveryQueue } from "../ports/delivery-queue.ts";
import { NotificationTargets, type FormScope } from "../ports/notification-targets.ts";
import { consumeDeliveries, deliverySchedulerLive } from "./delivery-outbox.ts";

const apiKey = "re_email_delivery_test_key";
const sender = EmailAddress.make("forms@rondyr.test");
const configured: EmailEnvironment = {
  RESEND_API_KEY: Redacted.make(apiKey),
  RONDYR_EMAIL_FROM: sender,
};

const Received = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
});
type Received = typeof Received.Type;
// The JSON body of POST /emails, as https://resend.com/docs/api-reference/emails/send-email describes it.
const ResendEmail = Schema.Struct({
  from: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
  reply_to: Schema.optionalKey(Schema.Array(Schema.String)),
});
const DeliveryRow = Schema.Struct({
  id: DeliveryId,
  status: DeliveryStatus,
  attempt_count: Schema.Int,
  last_error: Schema.NullOr(Schema.String),
});
const readReceived = Schema.decodeUnknownEffect(Schema.Array(Received));
const readEmail = Schema.decodeUnknownEffect(Schema.fromJsonString(ResendEmail));
const readCloudflareEmails = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      from: Schema.String,
      to: Schema.Array(Schema.String),
      subject: Schema.String,
      text: Schema.String,
      replyTo: Schema.optionalKey(Schema.String),
    }),
  ),
);
const readJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const readDeliveries = Schema.decodeUnknownEffect(Schema.Array(DeliveryRow));
const encodeFields = Schema.encodeEffect(Schema.fromJsonString(SubmissionFields));

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const cipher = secretCipherLayer(Effect.succeedSome(Redacted.make(testSecretsKey)));

/** Every request goes to the receiver fixture, which passes api.resend.com on to the Resend fixture. */
const outboundFetch: typeof globalThis.fetch = (input, init) =>
  env.WEBHOOK_RECEIVER.fetch(input, init);

function services(email: EmailEnvironment) {
  const queue = Layer.succeed(DeliveryQueue, { send: () => Effect.void });
  const stored = Layer.mergeAll(deliveryStoreLive, queue);
  const emailSender = emailSenderLayer(Effect.succeed(email)).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
  return Layer.mergeAll(
    stored,
    deliverySchedulerLive.pipe(Layer.provide(stored)),
    Layer.mergeAll(notificationProvidersLive, notificationTargetsLive).pipe(
      Layer.provide(Layer.mergeAll(cipher, emailSender, recipientConfirmationsLive)),
    ),
    Layer.succeed(FetchHttpClient.Fetch, outboundFetch),
  );
}

const withServices = <A, E, R>(layer: Layer.Layer<R>, scenario: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Layer.build(layer), (built) => Effect.provideContext(scenario, built));

/** A member of `<name>-org`, whose form `Form <name>` has one submission with `fields`. */
const seedForm = Effect.fnUntraced(function* (
  name: string,
  submissionId: SubmissionId,
  fields: typeof SubmissionFields.Type,
) {
  const stored = yield* encodeFields(fields);
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
      env.DB.prepare(
        "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, 0)",
      ).bind(submissionId, `${name}-org`, `${name}-form`, stored),
    ]),
  );
  const scope: FormScope = {
    userId: UserId.make(`${name}-user`),
    organizationId: OrganizationId.make(`${name}-org`),
    formPublicId: name,
  };
  return scope;
});

const recipientsOf = (addresses: ReadonlyArray<string>) =>
  Result.match(parseEmailRecipients(addresses), {
    onSuccess: (recipients) => recipients,
    onFailure: (reason) => assert.fail(`${addresses.join(", ")} is refused: ${reason}`),
  });

/** An email target whose recipients have all confirmed their address. */
const addEmailTarget = Effect.fnUntraced(function* (
  form: FormScope,
  addresses: ReadonlyArray<string>,
) {
  const targets = yield* NotificationTargets;
  const created = yield* targets.createEmail(form, recipientsOf(addresses), "en");
  yield* confirmRecipients(form.organizationId, addresses);
  return created;
});

const deliverAccepted = Effect.fnUntraced(function* (form: FormScope, submissionId: SubmissionId) {
  const scheduler = yield* DeliveryScheduler;
  const acceptedAt = yield* Clock.currentTimeMillis;
  yield* scheduler.schedule({ submissionId, organizationId: form.organizationId, acceptedAt });
});

const deliveriesOf = Effect.fnUntraced(function* (submissionId: string) {
  const rows = yield* Effect.promise(() =>
    env.DB.prepare(
      `SELECT d.id, d.status, d.attempt_count, d.last_error FROM deliveries d
        JOIN notification_targets t ON t.id = d.target_id
      WHERE d.submission_id = ? ORDER BY t.type`,
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

/** The requests that the Resend fixture received for a recipient. */
const sentTo = Effect.fnUntraced(function* (recipient: string) {
  const response = yield* Effect.promise(() =>
    env.RESEND_FIXTURE.fetch(
      `https://api.resend.com/__received?recipient=${encodeURIComponent(recipient)}`,
    ),
  );
  const json = yield* Effect.promise(() => response.json());
  return yield* readReceived(json);
});

const cloudflareSentTo = Effect.fnUntraced(function* (recipient: string) {
  const response = yield* Effect.promise(() =>
    env.CLOUDFLARE_EMAIL_FIXTURE.fetch(
      `https://email.test/__received?recipient=${encodeURIComponent(recipient)}`,
    ),
  );
  const json = yield* Effect.promise(() => response.json());
  return yield* readCloudflareEmails(json);
});

function cloudflareServices() {
  const binding = env.CLOUDFLARE_EMAIL;
  if (binding === undefined) return assert.fail("Expected the Cloudflare Email Sending fixture");
  return services({
    RONDYR_EMAIL_PROVIDER: "cloudflare",
    RONDYR_EMAIL_FROM: sender,
    CLOUDFLARE_EMAIL: binding,
  });
}

const webhookUrl = (url: string) =>
  Result.getOrElse(parseWebhookUrl(url, Option.none()), () => assert.fail(`${url} is refused`));

const contact = { email: "customer@example.test", message: "Is there room in the pottery class?" };

it.effect("sends one plain text email with the delivery ID as its idempotency key", () => {
  const submissionId = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b01");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("mailed", submissionId, contact);
    const target = yield* addEmailTarget(form, ["mailed-team@example.com", "owner@example.com"]);
    assert.deepEqual(
      [target.type, target.recipients, target.active],
      ["email", ["mailed-team@example.com", "owner@example.com"], true],
    );
    yield* deliverAccepted(form, submissionId);
    const [row] = yield* consume(submissionId);
    assert.deepEqual([row?.status, row?.attempt_count, row?.last_error], ["delivered", 1, null]);

    const [request, ...others] = yield* sentTo("mailed-team@example.com");
    if (request === undefined) return assert.fail("Resend got no request");
    assert.deepEqual(others, []);
    assert.deepEqual([request.method, request.url], ["POST", "https://api.resend.com/emails"]);
    assert.strictEqual(request.headers["authorization"], `Bearer ${apiKey}`);
    assert.strictEqual(request.headers["content-type"], "application/json");
    assert.strictEqual(request.headers["idempotency-key"], row?.id);
    assert.strictEqual(request.headers["user-agent"], "Rondyr-Email/1");
    assert.notProperty(request.headers, "traceparent");
    const json = yield* readJson(request.body);
    assert.deepEqual(json, {
      from: "forms@rondyr.test",
      to: ["mailed-team@example.com", "owner@example.com"],
      subject: "New message: Form mailed",
      reply_to: ["customer@example.test"],
      text: [
        "New message received through the form “Form mailed”.",
        "",
        "email:",
        "customer@example.test",
        "",
        "message:",
        "Is there room in the pottery class?",
        "",
        "-- ",
        "Form: Form mailed",
        "Received: 1 January 1970 at 00:00:00 UTC",
        `Delivery ID: ${row?.id ?? ""}`,
        "",
        "Rondyr may send the same delivery twice. Two messages with the same delivery ID are duplicates.",
        "",
      ].join("\n"),
    });
  });
  return withServices(services(configured), scenario);
});

it.effect("writes in French the email of a target stored before the language setting", () => {
  const submissionId = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b20");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("legacy", submissionId, contact);
    yield* Effect.promise(() =>
      env.DB.prepare(
        `INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
         VALUES ('legacy-email', 'legacy-org', 'legacy-form', 'email', ?, 0)`,
      )
        .bind('{"recipients":["legacy-team@example.com"]}')
        .run(),
    );
    yield* confirmRecipients(form.organizationId, ["legacy-team@example.com"]);
    yield* deliverAccepted(form, submissionId);
    yield* consume(submissionId);

    const [request] = yield* sentTo("legacy-team@example.com");
    const email = yield* readEmail(request?.body);

    assert.strictEqual(email.subject, "Nouveau message : Form legacy");
  });
  return withServices(services(configured), scenario);
});

it.effect("retries a 500 and a 429 with the same idempotency key and the same message", () => {
  const failing = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b02");
  const limited = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b03");
  const scenario = Effect.gen(function* () {
    const failingForm = yield* seedForm("unavailable", failing, contact);
    const limitedForm = yield* seedForm("limited", limited, contact);
    yield* addEmailTarget(failingForm, ["once-500@example.com"]);
    yield* addEmailTarget(limitedForm, ["once-429@example.com"]);
    yield* deliverAccepted(failingForm, failing);
    yield* deliverAccepted(limitedForm, limited);

    const [failed] = yield* consume(failing);
    const [throttled] = yield* consume(limited);
    // The error code reaches the summary, the message of the response does not.
    assert.deepEqual(
      [failed?.status, failed?.last_error, throttled?.status, throttled?.last_error],
      [
        "retrying",
        "Resend answered HTTP 500 (application_error).",
        "retrying",
        "Resend answered HTTP 429 (rate_limit_exceeded).",
      ],
    );

    yield* TestClock.adjust("1 minute");
    const [second] = yield* consume(failing);
    const [secondLimited] = yield* consume(limited);
    assert.deepEqual(
      [second?.status, second?.attempt_count, secondLimited?.status, secondLimited?.attempt_count],
      ["delivered", 2, "delivered", 2],
    );

    for (const [recipient, row] of [
      ["once-500@example.com", failed],
      ["once-429@example.com", throttled],
    ] as const) {
      const requests = yield* sentTo(recipient);
      assert.deepEqual(
        requests.map(({ headers }) => headers["idempotency-key"]),
        [row?.id, row?.id],
      );
      const [first, retry] = requests;
      assert.strictEqual(retry?.body, first?.body);
    }
  });
  return withServices(services(configured), scenario);
});

it.effect(
  "keeps the recipients of a delivery for its retries when an address is confirmed meanwhile",
  () => {
    const first = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b31");
    const later = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b32");
    const scenario = Effect.gen(function* () {
      const form = yield* seedForm("confirmed-meanwhile", first, contact);
      const stored = yield* encodeFields(contact);
      yield* Effect.promise(() =>
        env.DB.prepare(
          "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, 'confirmed-meanwhile-form', ?, 0)",
        )
          .bind(later, form.organizationId, stored)
          .run(),
      );
      const targets = yield* NotificationTargets;
      yield* targets.createEmail(
        form,
        recipientsOf(["once-500@meanwhile.example.com", "late-confirmed@example.com"]),
        "en",
      );
      yield* confirmRecipients(form.organizationId, ["once-500@meanwhile.example.com"]);
      yield* deliverAccepted(form, first);
      const [failed] = yield* consume(first);
      assert.strictEqual(failed?.status, "retrying");

      // The second address is confirmed between the two attempts of the delivery.
      yield* TestClock.adjust("30 seconds");
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.promise(() =>
        env.DB.prepare(`
        INSERT INTO email_recipient_confirmations (organization_id, address, confirmed_at, created_at)
        VALUES (?, 'late-confirmed@example.com', ?, ?)
      `)
          .bind(form.organizationId, now, now)
          .run(),
      );
      yield* TestClock.adjust("1 minute");
      const [delivered] = yield* consume(first);
      yield* deliverAccepted(form, later);
      yield* consume(later);

      const requests = yield* sentTo("once-500@meanwhile.example.com");
      const [attempt, retry, next] = yield* Effect.forEach(requests, ({ body }) => readEmail(body));
      assert.strictEqual(delivered?.status, "delivered");
      assert.deepEqual(requests.map(({ headers }) => headers["idempotency-key"]).slice(0, 2), [
        failed?.id,
        failed?.id,
      ]);
      assert.deepEqual(
        [attempt?.to, retry?.to, next?.to],
        [
          ["once-500@meanwhile.example.com"],
          ["once-500@meanwhile.example.com"],
          ["once-500@meanwhile.example.com", "late-confirmed@example.com"],
        ],
      );
      assert.strictEqual(requests[1]?.body, requests[0]?.body);
    });
    return withServices(services(configured), scenario);
  },
);

it.effect("ends the delivery without a retry when Resend refuses the request", () => {
  const ids = [
    SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b04"),
    SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b05"),
    SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b06"),
  ] as const;
  // A validation error, an invalid key, and an unverified sender domain.
  const statuses = ["422", "401", "403"] as const;
  const scenario = Effect.gen(function* () {
    const rows = yield* Effect.forEach(ids, (submissionId, index) =>
      Effect.gen(function* () {
        const status = statuses[index] ?? "422";
        const form = yield* seedForm(`refused-${status}`, submissionId, contact);
        yield* addEmailTarget(form, [`always-${status}@example.com`]);
        yield* deliverAccepted(form, submissionId);
        const [row] = yield* consume(submissionId);
        return row;
      }),
    );
    assert.deepEqual(
      rows.map((row) => [row?.status, row?.attempt_count, row?.last_error]),
      [
        ["failed", 1, "Resend answered HTTP 422 (validation_error)."],
        ["failed", 1, "Resend answered HTTP 401 (missing_api_key)."],
        ["failed", 1, "Resend answered HTTP 403 (validation_error)."],
      ],
    );
    yield* TestClock.adjust("1 day");
    yield* consume(ids[0]);
    const requests = yield* sentTo("always-422@example.com");
    assert.strictEqual(requests.length, 1);
  });
  return withServices(services(configured), scenario);
});

it.effect("keeps visitor input out of the headers and the subject", () => {
  const cases = [
    {
      id: SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b07"),
      email: "visitor@example.com\r\nBcc: victim@example.com",
    },
    {
      id: SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b08"),
      email: "visitor@example.com\n",
    },
    {
      id: SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b09"),
      email: "Visitor <visitor@example.com>",
    },
    {
      id: SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b10"),
      email: "visitor@example.com, victim@example.com",
    },
    { id: SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b11"), email: "not an address" },
  ];
  const scenario = Effect.gen(function* () {
    const emails = yield* Effect.forEach(cases, ({ id, email }, index) =>
      Effect.gen(function* () {
        const recipient = `injection-${index}@example.com`;
        const form = yield* seedForm(`injection-${index}`, id, {
          email,
          "Subject: urgent\r\nBcc: victim@example.com": "value\r\nBcc: victim@example.com",
          message: "Line one\r\nLine two\u2028Line three",
        });
        yield* addEmailTarget(form, [recipient]);
        yield* deliverAccepted(form, id);
        const [row] = yield* consume(id);
        assert.strictEqual(row?.status, "delivered");
        const [request] = yield* sentTo(recipient);
        if (request === undefined) return assert.fail(`Resend got no request for ${recipient}`);
        assert.notInclude(Object.values(request.headers).join("\n"), "victim");
        return yield* readEmail(request.body);
      }),
    );
    for (const [index, email] of emails.entries()) {
      // No Reply-To, no custom header, and a subject built from the form name only.
      assert.notProperty(email, "reply_to");
      assert.notProperty(email, "headers");
      assert.strictEqual(email.subject, `New message: Form injection-${index}`);
      assert.deepEqual(email.to, [`injection-${index}@example.com`]);
      // Field names stay on one line of the body; values keep their line breaks as \n.
      assert.include(
        email.text,
        "Subject: urgent Bcc: victim@example.com:\nvalue\nBcc: victim@example.com",
      );
      assert.include(email.text, "message:\nLine one\nLine two\nLine three");
      assert.notInclude(email.text, "\r");
    }
  });
  return withServices(services(configured), scenario);
});

it.effect("refuses an email target and fails its deliveries when no provider is configured", () => {
  const submissionId = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b12");
  const settings: ReadonlyArray<EmailEnvironment> = [
    {},
    { RESEND_API_KEY: Redacted.make(apiKey) },
    { RONDYR_EMAIL_FROM: sender },
    {
      RONDYR_EMAIL_PROVIDER: "cloudflare",
      RONDYR_EMAIL_FROM: sender,
      RESEND_API_KEY: Redacted.make(apiKey),
    },
  ];
  const refusals = Effect.forEach(settings, (email) =>
    withServices(
      services(email),
      Effect.gen(function* () {
        const targets = yield* NotificationTargets;
        const form: FormScope = {
          userId: UserId.make("unconfigured-user"),
          organizationId: OrganizationId.make("unconfigured-org"),
          formPublicId: "unconfigured",
        };
        const error = yield* Effect.flip(
          targets.createEmail(form, recipientsOf(["a@example.com"]), "en"),
        );
        return error._tag;
      }),
    ),
  );
  const delivery = Effect.gen(function* () {
    yield* seedForm("unconfigured", submissionId, contact);
    // A target created while the stage had a provider.
    yield* Effect.promise(() =>
      env.DB.prepare(
        `INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
        VALUES ('unconfigured-email', 'unconfigured-org', 'unconfigured-form', 'email', ?, 0)`,
      )
        .bind('{"recipients":["unconfigured@example.com"]}')
        .run(),
    );
    const form: FormScope = {
      userId: UserId.make("unconfigured-user"),
      organizationId: OrganizationId.make("unconfigured-org"),
      formPublicId: "unconfigured",
    };
    const targets = yield* NotificationTargets;
    const listed = yield* targets.list(form);
    assert.deepEqual(
      listed.map(({ id, type }) => [id, type]),
      [["unconfigured-email", "email"]],
    );
    yield* deliverAccepted(form, submissionId);
    const [row] = yield* consume(submissionId);
    assert.deepEqual(
      [row?.status, row?.attempt_count, row?.last_error],
      [
        "failed",
        1,
        "Email is not configured on this stage. Check the email provider and RONDYR_EMAIL_FROM.",
      ],
    );
    const requests = yield* sentTo("unconfigured@example.com");
    assert.deepEqual(requests, []);
  });
  return Effect.gen(function* () {
    yield* withServices(services({}), delivery);
    const tags = yield* refusals;
    assert.deepEqual(tags, [
      "EmailProviderMissing",
      "EmailProviderMissing",
      "EmailProviderMissing",
      "EmailProviderMissing",
    ]);
  });
});

it.effect("retries a Cloudflare rate limit with the same email and delivery ID", () => {
  const submissionId = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b33");
  const recipient = "rate-limit-once@example.test";
  return withServices(
    cloudflareServices(),
    Effect.gen(function* () {
      const form = yield* seedForm("cloudflare-retry", submissionId, contact);
      yield* addEmailTarget(form, [recipient, "studio@example.test"]);
      yield* deliverAccepted(form, submissionId);

      const [first] = yield* consume(submissionId);
      assert.deepEqual(
        [first?.status, first?.attempt_count, first?.last_error],
        ["retrying", 1, "Cloudflare Email Sending failed (E_RATE_LIMIT_EXCEEDED)."],
      );
      yield* TestClock.adjust("1 minute");
      const [retry] = yield* consume(submissionId);
      assert.deepEqual(
        [retry?.status, retry?.attempt_count, retry?.id],
        ["delivered", 2, first?.id],
      );

      const messages = yield* cloudflareSentTo(recipient);
      assert.lengthOf(messages, 2);
      const [message, repeated] = messages;
      if (message === undefined) return assert.fail("Expected an email");
      assert.deepEqual(message, repeated);
      assert.deepEqual(
        [message.from, message.to, message.subject, message.replyTo],
        [
          sender,
          [recipient, "studio@example.test"],
          "New message: Form cloudflare-retry",
          contact.email,
        ],
      );
      assert.include(message.text, contact.message);
      assert.include(message.text, `Delivery ID: ${first?.id}`);
    }),
  );
});

it.effect("ends a Cloudflare delivery without retry when the recipient is suppressed", () => {
  const submissionId = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b34");
  const recipient = "suppressed@example.test";
  return withServices(
    cloudflareServices(),
    Effect.gen(function* () {
      const form = yield* seedForm("cloudflare-suppressed", submissionId, contact);
      yield* addEmailTarget(form, [recipient]);
      yield* deliverAccepted(form, submissionId);

      const [row] = yield* consume(submissionId);
      assert.deepEqual(
        [row?.status, row?.attempt_count, row?.last_error],
        ["failed", 1, "Cloudflare Email Sending failed (E_RECIPIENT_SUPPRESSED)."],
      );
      const messages = yield* cloudflareSentTo(recipient);
      assert.lengthOf(messages, 1);
    }),
  );
});

it.effect("retries an unknown Cloudflare error without storing any returned text", () => {
  const submissionId = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b35");
  return withServices(
    cloudflareServices(),
    Effect.gen(function* () {
      const form = yield* seedForm("cloudflare-unknown", submissionId, contact);
      yield* addEmailTarget(form, ["unknown-error@example.test"]);
      yield* deliverAccepted(form, submissionId);

      const [row] = yield* consume(submissionId);
      assert.deepEqual(
        [row?.status, row?.last_error],
        ["retrying", "Cloudflare Email Sending failed without a known code."],
      );
    }),
  );
});

it.effect("delivers to a webhook and an email target of the same form independently", () => {
  const webhookFails = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b13");
  const emailFails = SubmissionId.make("6b1d2e3f-4051-4263-9b7c-8d9e0f1a2b14");
  const scenario = Effect.gen(function* () {
    const targets = yield* NotificationTargets;
    const first = yield* seedForm("both-webhook-fails", webhookFails, contact);
    yield* targets.createWebhook(
      first,
      webhookUrl("https://hooks.example.com/t/both-a/bad-request"),
    );
    yield* addEmailTarget(first, ["both-a@example.com"]);
    const second = yield* seedForm("both-email-fails", emailFails, contact);
    yield* targets.createWebhook(second, webhookUrl("https://hooks.example.com/t/both-b/ok"));
    yield* addEmailTarget(second, ["always-500@both.example.com"]);

    yield* deliverAccepted(first, webhookFails);
    yield* deliverAccepted(second, emailFails);
    // Rows are ordered by target type: email, then webhook.
    const firstRows = yield* consume(webhookFails);
    const secondRows = yield* consume(emailFails);
    assert.deepEqual(
      [...firstRows, ...secondRows].map(({ status, last_error }) => [status, last_error]),
      [
        ["delivered", null],
        ["failed", "The recipient answered HTTP 400."],
        ["retrying", "Resend answered HTTP 500 (application_error)."],
        ["delivered", null],
      ],
    );
    const mailed = yield* sentTo("both-a@example.com");
    assert.strictEqual(mailed.length, 1);
  });
  return withServices(services(configured), scenario);
});
