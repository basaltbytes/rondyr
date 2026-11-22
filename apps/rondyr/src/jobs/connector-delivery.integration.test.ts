import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Clock, Context, DateTime, Effect, Layer, Redacted, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import { testSecretsKey } from "../../tests/integration/auth-fixture.ts";
import { secretCipherLayer } from "../adapters/crypto/secret-cipher.ts";
import { deliveryStoreLive } from "../adapters/database/delivery-store.ts";
import { notificationTargetsLive } from "../adapters/database/notification-targets.ts";
import { recipientConfirmationsLive } from "../adapters/database/recipient-confirmations.ts";
import { emailSenderLayer } from "../adapters/email/email-sender.ts";
import { notificationProvidersLive } from "../adapters/notifications/notification-providers.ts";
import {
  parseConnectorDestination,
  type CreateConnectorTarget,
} from "../domain/deliveries/connectors/connector-target.ts";
import { DeliveryId, DeliveryStatus } from "../domain/deliveries/delivery.ts";
import { DeliveryScheduler } from "../domain/submissions/delivery-scheduler.external.ts";
import { SubmissionFields } from "../domain/submissions/submission-fields.ts";
import { OrganizationId, SubmissionId, UserId } from "../domain/submissions/submission.id.ts";
import { DeliveryQueue } from "../ports/delivery-queue.ts";
import { NotificationTargets, type FormScope } from "../ports/notification-targets.ts";
import {
  consumeDeliveries,
  deliverySchedulerLive,
  sendTestNotification,
} from "./delivery-outbox.ts";

const contact = { email: "customer@example.test", message: "Is there room in the pottery class?" };
const airtableToken = "patConnectorTest0123456789.abcdef0123456789";

const Received = Schema.Struct({
  path: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.fromJsonString(Schema.Json),
});
const DeliveryRow = Schema.Struct({
  id: DeliveryId,
  status: DeliveryStatus,
  attempt_count: Schema.Int,
  last_error: Schema.NullOr(Schema.String),
});
const readReceived = Schema.decodeUnknownEffect(Schema.Array(Received));
const readDeliveries = Schema.decodeUnknownEffect(Schema.Array(DeliveryRow));
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

const queue = Layer.succeed(DeliveryQueue, { send: () => Effect.void });
const stored = Layer.mergeAll(deliveryStoreLive, queue);
const services = Layer.mergeAll(
  stored,
  deliverySchedulerLive.pipe(Layer.provide(stored)),
  Layer.mergeAll(notificationProvidersLive, notificationTargetsLive).pipe(
    Layer.provide(Layer.mergeAll(cipher, noEmail, recipientConfirmationsLive)),
  ),
  Layer.succeed(FetchHttpClient.Fetch, receiverFetch),
);

const withServices = <A, E, R>(scenario: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Layer.build(Layer.fresh(services)), (built) =>
    Effect.provideContext(scenario, built),
  );

/** A member of `<name>-org`, whose form `<name>` has one submission, received at the epoch. */
const seedForm = Effect.fnUntraced(function* (name: string, submissionId: string) {
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
      env.DB.prepare(
        "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, 0)",
      ).bind(submissionId, `${name}-org`, `${name}-form`, fields),
    ]),
  );
  const scope: FormScope = {
    userId: UserId.make(`${name}-user`),
    organizationId: OrganizationId.make(`${name}-org`),
    formPublicId: name,
  };
  return scope;
});

/** The destination that the admin API would store for this request. */
const destination = (input: typeof CreateConnectorTarget.Type) =>
  Result.match(parseConnectorDestination(input), {
    onSuccess: (accepted) => accepted,
    onFailure: (refusal) => assert.fail(`The destination is refused: ${refusal.error}`),
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
      "SELECT id, status, attempt_count, last_error FROM deliveries WHERE submission_id = ? ORDER BY created_at, target_id",
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

const storedConfiguration = (targetId: string) =>
  Effect.promise(() =>
    env.DB.prepare("SELECT configuration FROM notification_targets WHERE id = ?")
      .bind(targetId)
      .first("configuration"),
  );

it.effect("posts an accepted message to the Discord webhook of a destination", () => {
  const submissionId = SubmissionId.make("6b1c2d3e-4f50-4162-9a7b-8c9d0e1f2a01");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("discord-ok", submissionId);
    const targets = yield* NotificationTargets;
    yield* targets.createConnector(
      form,
      destination({
        type: "discord",
        name: "Sales channel",
        settings: { webhookUrl: "https://discord.com/api/webhooks/1000000001/ok" },
      }),
    );

    yield* deliverAccepted(form, submissionId);
    const [row] = yield* consume(submissionId);

    assert.deepEqual([row?.status, row?.attempt_count, row?.last_error], ["delivered", 1, null]);
    const requests = yield* receivedUnder("/api/webhooks/1000000001/");
    assert.deepEqual(
      requests.map(({ method, path, headers, body }) => ({
        method,
        path,
        type: headers["content-type"],
        trace: headers["traceparent"],
        body,
      })),
      [
        {
          method: "POST",
          path: "/api/webhooks/1000000001/ok",
          type: "application/json",
          trace: undefined,
          body: {
            embeds: [
              {
                title: "Form discord-ok",
                fields: [
                  { name: "email", value: "customer@example.test", inline: false },
                  { name: "message", value: "Is there room in the pottery class?", inline: false },
                ],
                footer: { text: `Rondyr · ${row?.id}` },
                timestamp: "1970-01-01T00:00:00.000Z",
              },
            ],
            allowed_mentions: { parse: [] },
          },
        },
      ],
    );
  });
  return withServices(scenario);
});

it.effect("retries a Slack webhook that answers 500, then delivers the same message", () => {
  const submissionId = SubmissionId.make("6b1c2d3e-4f50-4162-9a7b-8c9d0e1f2a02");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("slack-flaky", submissionId);
    const targets = yield* NotificationTargets;
    yield* targets.createConnector(
      form,
      destination({
        type: "slack",
        name: "Leads",
        settings: { webhookUrl: "https://hooks.slack.com/services/T0000002/B0000002/fail-once" },
      }),
    );
    yield* deliverAccepted(form, submissionId);

    const [first] = yield* consume(submissionId);
    yield* TestClock.adjust("1 minute");
    const [second] = yield* consume(submissionId);

    // Only the status reaches the summary, not the body of the response.
    assert.deepEqual([first?.status, first?.last_error], ["retrying", "Slack answered HTTP 500."]);
    assert.deepEqual([second?.status, second?.attempt_count], ["delivered", 2]);
    const requests = yield* receivedUnder("/services/T0000002/B0000002/");
    assert.strictEqual(requests.length, 2);
    assert.deepEqual(requests[0]?.body, requests[1]?.body);
  });
  return withServices(scenario);
});

it.effect("writes a row in Airtable with the token that D1 keeps sealed", () => {
  const submissionId = SubmissionId.make("6b1c2d3e-4f50-4162-9a7b-8c9d0e1f2a03");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("airtable-ok", submissionId);
    const targets = yield* NotificationTargets;
    const target = yield* targets.createConnector(
      form,
      destination({
        type: "airtable",
        name: "Leads table",
        settings: {
          token: airtableToken,
          baseId: "appAirtableOk0001",
          table: "ok",
          idColumn: "Rondyr ID",
        },
      }),
    );

    yield* deliverAccepted(form, submissionId);
    const [row] = yield* consume(submissionId);

    assert.deepEqual([row?.status, row?.last_error], ["delivered", null]);
    // The API returns the settings that are not secrets, and D1 has no token in clear.
    assert.deepEqual(target.settings, {
      baseId: "appAirtableOk0001",
      table: "ok",
      idColumn: "Rondyr ID",
    });
    const configuration = yield* storedConfiguration(target.id);
    assert.notInclude(String(configuration), airtableToken);
    const requests = yield* receivedUnder("/v0/appAirtableOk0001/");
    assert.deepEqual(
      requests.map(({ method, headers, body }) => ({
        method,
        authorization: headers["authorization"],
        body,
      })),
      [
        {
          method: "PATCH",
          authorization: `Bearer ${airtableToken}`,
          body: {
            records: [{ fields: { ...contact, "Rondyr ID": submissionId } }],
            typecast: true,
            performUpsert: { fieldsToMergeOn: ["Rondyr ID"] },
          },
        },
      ],
    );
  });
  return withServices(scenario);
});

it.effect("ends the delivery when Airtable does not find the table, and says what to check", () => {
  const submissionId = SubmissionId.make("6b1c2d3e-4f50-4162-9a7b-8c9d0e1f2a04");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("airtable-missing", submissionId);
    const targets = yield* NotificationTargets;
    yield* targets.createConnector(
      form,
      destination({
        type: "airtable",
        name: "Leads table",
        // The receiver answers 404 to a path that it does not know.
        settings: { token: airtableToken, baseId: "appAirtableMiss01", table: "Renamed" },
      }),
    );

    yield* deliverAccepted(form, submissionId);
    const [row] = yield* consume(submissionId);

    assert.deepEqual(
      [row?.status, row?.attempt_count, row?.last_error],
      ["failed", 1, "Airtable answered HTTP 404. Airtable did not find the base or the table."],
    );
  });
  return withServices(scenario);
});

it.effect("sends nothing for settings changed in D1 that no longer fit the connector", () => {
  const submissionId = SubmissionId.make("6b1c2d3e-4f50-4162-9a7b-8c9d0e1f2a05");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("airtable-stale", submissionId);
    const targets = yield* NotificationTargets;
    const target = yield* targets.createConnector(
      form,
      destination({
        type: "airtable",
        name: "Leads table",
        settings: { token: airtableToken, baseId: "appAirtableStal01", table: "ok" },
      }),
    );
    yield* Effect.promise(() =>
      env.DB.prepare(
        "UPDATE notification_targets SET configuration = json_set(configuration, '$.settings.baseId', 'internal.example/v0') WHERE id = ?",
      )
        .bind(target.id)
        .run(),
    );

    yield* deliverAccepted(form, submissionId);
    const [row] = yield* consume(submissionId);

    assert.deepEqual(
      [row?.status, row?.last_error],
      ["failed", "The settings of this destination no longer fit Airtable. Save them again."],
    );
    const requests = yield* receivedUnder("/v0/internal.example/");
    assert.deepEqual(requests, []);
  });
  return withServices(scenario);
});

it.effect("ends the delivery when a secret was sealed with another RONDYR_SECRETS_KEY", () => {
  const submissionId = SubmissionId.make("6b1c2d3e-4f50-4162-9a7b-8c9d0e1f2a06");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("discord-rekeyed", submissionId);
    const foreign = Layer.fresh(
      notificationTargetsLive.pipe(Layer.provide(Layer.mergeAll(otherCipher, noEmail))),
    );
    const foreignTargets = yield* Effect.scoped(
      Effect.map(Layer.build(foreign), (built) => Context.get(built, NotificationTargets)),
    );
    yield* foreignTargets.createConnector(
      form,
      destination({
        type: "discord",
        name: "Sales channel",
        settings: { webhookUrl: "https://discord.com/api/webhooks/1000000006/ok" },
      }),
    );

    yield* deliverAccepted(form, submissionId);
    const [row] = yield* consume(submissionId);

    assert.deepEqual(
      [row?.status, row?.last_error],
      ["failed", "A secret of this destination cannot be decrypted."],
    );
    const requests = yield* receivedUnder("/api/webhooks/1000000006/");
    assert.deepEqual(requests, []);
  });
  return withServices(scenario);
});

it.effect("tests an Airtable destination with an empty row, and stores no delivery", () => {
  const submissionId = SubmissionId.make("6b1c2d3e-4f50-4162-9a7b-8c9d0e1f2a07");
  const scenario = Effect.gen(function* () {
    const form = yield* seedForm("airtable-test", submissionId);
    const targets = yield* NotificationTargets;
    const target = yield* targets.createConnector(
      form,
      destination({
        type: "airtable",
        name: "Leads table",
        settings: { token: airtableToken, baseId: "appAirtableTest01", table: "ok" },
      }),
    );
    const testable = yield* targets.testable({
      userId: form.userId,
      organizationId: form.organizationId,
      targetId: target.id,
    });

    const result = yield* sendTestNotification(testable);

    assert.strictEqual(result.outcome, "delivered");
    const requests = yield* receivedUnder("/v0/appAirtableTest01/");
    assert.deepEqual(
      requests.map(({ method, body }) => ({ method, body })),
      [{ method: "POST", body: { records: [{ fields: {} }], typecast: true } }],
    );
    const deliveries = yield* deliveriesOf(submissionId);
    assert.deepEqual(deliveries, []);
  });
  return withServices(scenario);
});
