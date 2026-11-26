import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Clock, Effect, Layer, Schema } from "effect";

import { testOrigin as origin } from "../../../tests/integration/auth-fixture.ts";
import { setupOwner } from "../../../tests/integration/organization-fixture.ts";
import { deliveryStoreLive } from "../adapters/database/delivery-store.ts";
import { DeliveryScheduler } from "../../domain/submissions/delivery-scheduler.external.ts";
import { InboxOrganizationWithForms } from "../../domain/submissions/inbox-setup.ts";
import { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import { DeliveryQueue } from "../ports/delivery-queue.ts";
import { deliverySchedulerLive } from "./delivery-outbox.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));
const readInboxes = Schema.decodeUnknownEffect(Schema.Array(InboxOrganizationWithForms));
const DeliveryRow = Schema.Struct({
  target_id: Schema.String,
  status: Schema.String,
  attempt_count: Schema.Int,
  last_error: Schema.NullOr(Schema.String),
  outcomes: Schema.String,
});
const readDeliveries = Schema.decodeUnknownEffect(Schema.Array(DeliveryRow));
const contact = { email: "customer@example.test", message: "Is there room in the pottery class?" };
const privateFieldName = "workerd-private-field-name-44cd68";
const privateFieldValue = "workerd-private-field-value-ca31b7";
const invalidConfiguration = "The webhook target configuration is invalid.";

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

const submit = Effect.fnUntraced(function* (publicId: string, fields: Schema.Json) {
  const response = yield* post(`/f/${publicId}`, fields);
  assert.strictEqual(response.status, 202);
  const body = yield* Effect.promise(() => response.json());
  const { "submission-id": submissionId } = yield* readAccepted(body);
  return submissionId;
});

const deliveriesQuery = `
  SELECT d.target_id, d.status, d.attempt_count, d.last_error,
    (SELECT group_concat(a.outcome) FROM delivery_attempts a WHERE a.delivery_id = d.id) AS outcomes
  FROM deliveries d WHERE d.submission_id = ? ORDER BY d.target_id
`;

const deliveriesOf = Effect.fnUntraced(function* (submissionId: SubmissionId) {
  const rows = yield* Effect.promise(() =>
    env.DB.prepare(deliveriesQuery).bind(submissionId).all(),
  );
  return yield* readDeliveries(rows.results);
});

// The webhook targets below have an empty configuration, so the deployed
// webhook provider fails them on their first attempt without sending anything:
// the end of the path from acceptance to the consumer.
const waitForFailedWebhook = (submissionId: SubmissionId) =>
  Effect.promise(() =>
    vi.waitFor(
      () =>
        env.DB.prepare(deliveriesQuery)
          .bind(submissionId)
          .all()
          .then(({ results }) => {
            assert.deepEqual(results, [
              {
                target_id: "studio-webhook",
                status: "failed",
                attempt_count: 1,
                last_error: invalidConfiguration,
                outcomes: "permanent-failure",
              },
            ]);
          }),
      { timeout: 20_000, interval: 100 },
    ),
  );

it.live(
  "creates one delivery per target on automatic and manual acceptance, within the organization",
  () =>
    Effect.gen(function* () {
      const { cookie } = yield* setupOwner({ name: "Potter", email: "potter@example.test" });
      const headers = { cookie, origin };
      const created = yield* post(
        "/api/organizations",
        {
          organizationName: "Pottery studio",
          formName: "Classes",
          businessContext: "Pottery workshops",
        },
        headers,
      );
      assert.strictEqual(created.status, 201);
      const inboxesResponse = yield* request("/api/organizations", { headers });
      const inboxesRaw = yield* Effect.promise(() => inboxesResponse.json());
      const [inbox] = yield* readInboxes(inboxesRaw);
      const form = inbox?.forms[0];
      if (inbox === undefined || form === undefined) {
        return assert.fail("The new inbox should have a form");
      }

      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare(`
            INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
            SELECT 'studio-webhook', organization_id, id, 'webhook', '{}', 0 FROM forms WHERE public_id = ?
          `).bind(form.publicId),
          env.DB.prepare(
            "INSERT INTO organizations (id, name) VALUES ('elsewhere-org', 'Elsewhere')",
          ),
          env.DB.prepare(
            "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('elsewhere-form', 'elsewhere-org', 'elsewhere', 'Elsewhere')",
          ),
          env.DB.prepare(`
            INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
            VALUES ('elsewhere-webhook', 'elsewhere-org', 'elsewhere-form', 'webhook', '{}', 0)
          `),
        ]),
      );

      // The workerd Workers AI fixture accepts this message.
      const automatic = yield* submit(form.publicId, {
        ...contact,
        "fixture-verdict": "accept",
        [privateFieldName]: privateFieldValue,
      });
      const manual = yield* submit(form.publicId, contact);

      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.DB.prepare("SELECT status FROM submission_inbox WHERE submission_id = ?")
              .bind(manual)
              .first("status")
              .then((status) => {
                assert.strictEqual(status, "quarantined");
              }),
          { timeout: 15_000, interval: 100 },
        ),
      );
      const quarantined = yield* deliveriesOf(manual);
      assert.deepEqual(quarantined, []);
      const approval = yield* request(
        `/api/organizations/${inbox.id}/submissions/${manual}/approve`,
        { method: "POST", headers },
      );
      assert.strictEqual(approval.status, 200);

      yield* waitForFailedWebhook(automatic);
      yield* waitForFailedWebhook(manual);
      const status = yield* Effect.promise(() =>
        env.DB.prepare("SELECT status FROM submission_inbox WHERE submission_id = ?")
          .bind(automatic)
          .first("status"),
      );
      assert.strictEqual(status, "accepted");

      // The policy runs at least once: a second run for the same acceptance adds nothing.
      const queue = Layer.succeed(DeliveryQueue, { send: () => Effect.void });
      const scheduler = yield* Layer.build(
        deliverySchedulerLive.pipe(Layer.provide(Layer.mergeAll(deliveryStoreLive, queue))),
      );
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.gen(function* () {
        const deliveries = yield* DeliveryScheduler;
        yield* deliveries.schedule({
          submissionId: automatic,
          organizationId: OrganizationId.make(inbox.id),
          acceptedAt: now,
        });
      }).pipe(Effect.provideContext(scheduler));
      const rows = yield* deliveriesOf(automatic);
      assert.deepEqual(
        rows.map(({ target_id, attempt_count }) => [target_id, attempt_count]),
        [["studio-webhook", 1]],
      );
      const deliveryId = yield* Effect.promise(() =>
        env.DB.prepare("SELECT id FROM deliveries WHERE submission_id = ?")
          .bind(automatic)
          .first<string>("id"),
      );
      assert.isNotNull(deliveryId);

      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.WORKER_LOGS.fetch(`${origin}/`)
              .then((response) => response.text())
              .then((logs) => {
                assert.include(logs, "Delivery attempt finished");
                assert.include(logs, deliveryId);
                assert.notInclude(logs, privateFieldName);
                assert.notInclude(logs, privateFieldValue);
              }),
          { timeout: 5_000, interval: 100 },
        ),
      );
    }),
  45_000,
);
