import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";

import { deliveryStoreLive } from "../adapters/database/delivery-store.ts";
import { notificationProviders } from "../adapters/notifications/notification-providers.ts";
import { testNotificationProvider } from "../adapters/notifications/test-notification-provider.ts";
import {
  DeliveryId,
  DeliveryStatus,
  maxDeliveryAttempts,
  retryDelays,
} from "../../domain/deliveries/delivery.ts";
import { DeliveryScheduler } from "../../domain/submissions/delivery-scheduler.external.ts";
import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import { DeliveryQueue } from "../ports/delivery-queue.ts";
import {
  NotificationFailed,
  type Notification,
  type NotificationProvider,
} from "../ports/notification-provider.ts";
import {
  consumeDeliveries,
  deliverySchedulerLive,
  publishPendingDeliveries,
} from "./delivery-outbox.ts";

const contact = { email: "customer@example.test", message: "Is there room in the pottery class?" };

const DeliveryRow = Schema.Struct({
  id: DeliveryId,
  target_id: Schema.String,
  status: DeliveryStatus,
  attempt_count: Schema.Int,
  last_error: Schema.NullOr(Schema.String),
  next_attempt_at: Schema.Int,
});
const AttemptRow = Schema.Struct({
  attempt: Schema.Int,
  outcome: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
const readDeliveries = Schema.decodeUnknownEffect(Schema.Array(DeliveryRow));
const readAttempts = Schema.decodeUnknownEffect(Schema.Array(AttemptRow));
const encodeFields = Schema.encodeEffect(Schema.fromJsonString(SubmissionFields));

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const run = (statement: D1PreparedStatement) => Effect.promise(() => statement.run());

/** An organization `<name>-org` with a form `<name>-form` and one submission. */
const seedSubmission = Effect.fnUntraced(function* (
  name: string,
  organization: string,
  submissionId: SubmissionId,
) {
  const fields = yield* encodeFields(contact);
  yield* Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO organizations (id, name) VALUES (?, ?)").bind(
        organization,
        organization,
      ),
      env.DB.prepare(
        "INSERT INTO forms (id, organization_id, public_id, name) VALUES (?, ?, ?, ?)",
      ).bind(`${name}-form`, organization, name, name),
      env.DB.prepare(
        "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, 0)",
      ).bind(submissionId, organization, `${name}-form`, fields),
    ]),
  );
});

function seedTarget(
  id: string,
  organization: string,
  form: string,
  type: string,
  active = true,
  createdAt = 0,
) {
  return run(
    env.DB.prepare(
      "INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, active, created_at) VALUES (?, ?, ?, ?, '{}', ?, ?)",
    ).bind(id, organization, form, type, active ? 1 : 0, createdAt),
  );
}

const deliveriesOf = Effect.fnUntraced(function* (submissionId: SubmissionId) {
  const rows = yield* Effect.promise(() =>
    env.DB.prepare(
      "SELECT id, target_id, status, attempt_count, last_error, next_attempt_at FROM deliveries WHERE submission_id = ? ORDER BY target_id",
    )
      .bind(submissionId)
      .all(),
  );
  return yield* readDeliveries(rows.results);
});

const deliveryFor = Effect.fnUntraced(function* (submissionId: SubmissionId, targetId: string) {
  const rows = yield* deliveriesOf(submissionId);
  const row = rows.find((delivery) => delivery.target_id === targetId);
  if (row === undefined) return assert.fail(`No delivery for target ${targetId}`);
  return row;
});

const attemptsOf = Effect.fnUntraced(function* (deliveryId: DeliveryId) {
  const rows = yield* Effect.promise(() =>
    env.DB.prepare(
      "SELECT attempt, outcome, error FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt",
    )
      .bind(deliveryId)
      .all(),
  );
  return yield* readAttempts(rows.results);
});

const sentAt = DateTime.toDateUtc(DateTime.makeUnsafe(0));

/** A queue batch whose messages record whether the consumer acknowledged or retried them. */
function deliveryBatch(deliveryIds: ReadonlyArray<DeliveryId>) {
  const settled: Array<string> = [];
  const messages = deliveryIds.map((deliveryId, index): Message => ({
    id: `message-${index}`,
    timestamp: sentAt,
    attempts: 1,
    body: { deliveryId },
    ack: () => {
      settled.push(`ack ${deliveryId}`);
    },
    retry: () => {
      settled.push(`retry ${deliveryId}`);
    },
  }));
  const batch: MessageBatch = {
    queue: "rondyr-delivery",
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => {},
    retryAll: () => {},
  };
  return { batch, settled };
}

/**
 * D1, the test provider for targets of type `test`, and a queue that records what
 * it is sent instead of delivering it, so each test drives the consumer itself.
 */
function servicesWith(provider: NotificationProvider["Service"]) {
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
    notificationProviders(new Map([["test", provider]])),
    deliverySchedulerLive.pipe(Layer.provide(stored)),
  );
  return { sent, layer };
}

const schedule = Effect.fnUntraced(function* (
  submissionId: SubmissionId,
  organization: string,
  acceptedAt = 0,
) {
  const scheduler = yield* DeliveryScheduler;
  yield* scheduler.schedule({
    submissionId,
    organizationId: OrganizationId.make(organization),
    acceptedAt,
  });
});

const delivered = () => Effect.void;

const refuse = (notification: Notification) =>
  notification.target.id === "independent-refused"
    ? Effect.fail(
        NotificationFailed.make({
          retryable: false,
          summary: "The recipient refused the message (HTTP 410).",
        }),
      )
    : Effect.void;

const unavailable = () =>
  Effect.fail(
    NotificationFailed.make({ retryable: true, summary: "The recipient answered HTTP 503." }),
  );

/** Build the test's services once, so the scenario and its assertions share them. */
const withServices = <A, E, R>(layer: Layer.Layer<R>, scenario: Effect.Effect<A, E, R>) =>
  Effect.flatMap(Layer.build(layer), (services) => Effect.provideContext(scenario, services));

it.effect("creates one delivery per active target of the form, once", () => {
  const { sent, layer } = servicesWith(testNotificationProvider(delivered).provider);
  const submissionId = SubmissionId.make("6f1a0c3e-6b7d-4e55-9a51-2f1f7f1d0a01");
  const emptyFormSubmission = SubmissionId.make("6f1a0c3e-6b7d-4e55-9a51-2f1f7f1d0a02");
  const otherSubmission = SubmissionId.make("6f1a0c3e-6b7d-4e55-9a51-2f1f7f1d0a03");
  const scenario = Effect.gen(function* () {
    yield* seedSubmission("plan", "plan-org", submissionId);
    yield* seedSubmission("plan-empty", "plan-org", emptyFormSubmission);
    yield* seedSubmission("plan-other", "plan-other-org", otherSubmission);
    yield* seedTarget("plan-test", "plan-org", "plan-form", "test");
    yield* seedTarget("plan-webhook", "plan-org", "plan-form", "webhook");
    yield* seedTarget("plan-inactive", "plan-org", "plan-form", "test", false);
    // Created after the acceptance below: a new target never receives older messages.
    yield* seedTarget("plan-later", "plan-org", "plan-form", "test", true, 6_000);
    // A target of another organization's form, and a row that names this form for
    // another organization.
    yield* seedTarget("plan-foreign", "plan-other-org", "plan-other-form", "test");
    yield* seedTarget("plan-misscoped", "plan-other-org", "plan-form", "test");

    // A duplicate SubmissionAccepted runs the policy, and so the scheduler, twice.
    yield* schedule(submissionId, "plan-org", 5_000);
    yield* schedule(submissionId, "plan-org", 5_000);
    yield* schedule(emptyFormSubmission, "plan-org", 5_000);
    // An event naming another organization than the submission's creates nothing.
    yield* schedule(submissionId, "plan-other-org", 5_000);

    const rows = yield* deliveriesOf(submissionId);
    assert.deepEqual(
      rows.map(({ target_id, status, attempt_count }) => [target_id, status, attempt_count]),
      [
        ["plan-test", "pending", 0],
        ["plan-webhook", "pending", 0],
      ],
    );
    assert.notStrictEqual(rows[0]?.id, rows[1]?.id);
    assert.deepEqual(sent.toSorted(), rows.map(({ id }) => id).toSorted());
    const empty = yield* deliveriesOf(emptyFormSubmission);
    assert.deepEqual(empty, []);
  });
  return withServices(layer, scenario);
});

it.effect("delivers each target on its own and ignores a duplicate queue message", () => {
  const recipient = testNotificationProvider(refuse);
  const { layer } = servicesWith(recipient.provider);
  const submissionId = SubmissionId.make("0b6c5a8e-1d2f-4a3b-8c4d-5e6f7a8b9c01");
  const noProvider = 'No notification provider for target type "webhook".';
  const scenario = Effect.gen(function* () {
    yield* seedSubmission("independent", "independent-org", submissionId);
    yield* seedTarget("independent-ok", "independent-org", "independent-form", "test");
    yield* seedTarget("independent-refused", "independent-org", "independent-form", "test");
    yield* seedTarget("independent-webhook", "independent-org", "independent-form", "webhook");
    yield* schedule(submissionId, "independent-org");
    const ok = yield* deliveryFor(submissionId, "independent-ok");
    const refused = yield* deliveryFor(submissionId, "independent-refused");
    const webhook = yield* deliveryFor(submissionId, "independent-webhook");

    const { batch, settled } = deliveryBatch([ok.id, ok.id, refused.id, webhook.id]);
    yield* consumeDeliveries(batch);
    assert.sameMembers(settled, [
      `ack ${ok.id}`,
      `ack ${ok.id}`,
      `ack ${refused.id}`,
      `ack ${webhook.id}`,
    ]);
    assert.sameDeepMembers(
      recipient.received.map(({ deliveryId, target }) => [deliveryId, target.id]),
      [
        [ok.id, "independent-ok"],
        [refused.id, "independent-refused"],
      ],
    );
    assert.deepEqual(recipient.received[0]?.fields, contact);

    const rows = yield* deliveriesOf(submissionId);
    assert.deepEqual(
      rows.map(({ target_id, status, attempt_count, last_error }) => [
        target_id,
        status,
        attempt_count,
        last_error,
      ]),
      [
        ["independent-ok", "delivered", 1, null],
        ["independent-refused", "failed", 1, "The recipient refused the message (HTTP 410)."],
        ["independent-webhook", "failed", 1, noProvider],
      ],
    );
    const okAttempts = yield* attemptsOf(ok.id);
    assert.deepEqual(okAttempts, [{ attempt: 1, outcome: "delivered", error: null }]);
    const webhookAttempts = yield* attemptsOf(webhook.id);
    assert.deepEqual(webhookAttempts, [
      { attempt: 1, outcome: "permanent-failure", error: noProvider },
    ]);

    // A message for a finished delivery is acknowledged without a new attempt.
    const late = deliveryBatch([ok.id, refused.id]);
    yield* consumeDeliveries(late.batch);
    assert.sameMembers(late.settled, [`ack ${ok.id}`, `ack ${refused.id}`]);
    assert.strictEqual(recipient.received.length, 2);
  });
  return withServices(layer, scenario);
});

it.effect(
  "sends again with the same delivery id after a crash between the send and its record",
  () => {
    let calls = 0;
    // The first send reaches the recipient, then the Worker stops before it stores the result.
    const crashOnce = () => {
      calls += 1;
      return calls === 1 ? Effect.die("The Worker stopped") : Effect.void;
    };
    const recipient = testNotificationProvider(crashOnce);
    const { sent, layer } = servicesWith(recipient.provider);
    const submissionId = SubmissionId.make("3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b01");
    const scenario = Effect.gen(function* () {
      yield* seedSubmission("crash", "crash-org", submissionId);
      yield* seedTarget("crash-test", "crash-org", "crash-form", "test");
      yield* schedule(submissionId, "crash-org");
      const { id } = yield* deliveryFor(submissionId, "crash-test");

      const first = deliveryBatch([id]);
      const crashed = yield* Effect.exit(consumeDeliveries(first.batch));
      assert.isTrue(Exit.hasDies(crashed));
      assert.deepEqual(first.settled, []);
      const running = yield* attemptsOf(id);
      assert.deepEqual(running, [{ attempt: 1, outcome: null, error: null }]);
      const crashedRow = yield* deliveryFor(submissionId, "crash-test");
      assert.strictEqual(crashedRow.status, "processing");

      // The queue delivers the message again while the attempt's lease runs: no second send.
      const redelivered = deliveryBatch([id]);
      yield* consumeDeliveries(redelivered.batch);
      assert.deepEqual(redelivered.settled, [`ack ${id}`]);
      assert.strictEqual(recipient.received.length, 1);
      sent.length = 0;
      yield* publishPendingDeliveries();
      assert.notInclude(sent, id);

      // Once the lease expires, the cron publishes the delivery and a new attempt sends it.
      yield* TestClock.adjust("2 minutes");
      yield* publishPendingDeliveries();
      assert.include(sent, id);
      const retried = deliveryBatch([id]);
      yield* consumeDeliveries(retried.batch);
      assert.deepEqual(retried.settled, [`ack ${id}`]);

      assert.deepEqual(
        recipient.received.map(({ deliveryId }) => deliveryId),
        [id, id],
      );
      const row = yield* deliveryFor(submissionId, "crash-test");
      assert.deepEqual([row.status, row.attempt_count], ["delivered", 2]);
      const attempts = yield* attemptsOf(id);
      assert.deepEqual(
        attempts.map(({ attempt, outcome }) => [attempt, outcome]),
        [
          [1, "interrupted"],
          [2, "delivered"],
        ],
      );
    });
    return withServices(layer, scenario);
  },
);

it.effect("stores the same bounded error on a delivery and its attempt", () => {
  const summary = "Recipient failure. ".repeat(20);
  const recipient = testNotificationProvider(() =>
    Effect.fail(NotificationFailed.make({ retryable: false, summary })),
  );
  const { layer } = servicesWith(recipient.provider);
  const submissionId = SubmissionId.make("f01869e3-b329-4699-a141-377eee81a7dc");
  const scenario = Effect.gen(function* () {
    yield* seedSubmission("bounded-error", "bounded-error-org", submissionId);
    yield* seedTarget("bounded-error-test", "bounded-error-org", "bounded-error-form", "test");
    yield* schedule(submissionId, "bounded-error-org");
    const { id } = yield* deliveryFor(submissionId, "bounded-error-test");
    yield* consumeDeliveries(deliveryBatch([id]).batch);

    const error = `${summary.slice(0, 299)}…`;
    const row = yield* deliveryFor(submissionId, "bounded-error-test");
    assert.strictEqual(row.last_error, error);
    const attempts = yield* attemptsOf(id);
    assert.deepEqual(attempts, [{ attempt: 1, outcome: "permanent-failure", error }]);
  });
  return withServices(layer, scenario);
});

it.effect("retries a failing target after growing delays, then marks it failed", () => {
  const recipient = testNotificationProvider(unavailable);
  const { sent, layer } = servicesWith(recipient.provider);
  const submissionId = SubmissionId.make("9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b01");
  const scenario = Effect.gen(function* () {
    yield* seedSubmission("retry", "retry-org", submissionId);
    yield* seedTarget("retry-test", "retry-org", "retry-form", "test");
    yield* schedule(submissionId, "retry-org");
    const { id } = yield* deliveryFor(submissionId, "retry-test");

    for (let attempt = 1; attempt <= maxDeliveryAttempts; attempt += 1) {
      const { batch, settled } = deliveryBatch([id]);
      yield* consumeDeliveries(batch);
      assert.deepEqual(settled, [`ack ${id}`]);
      const row = yield* deliveryFor(submissionId, "retry-test");
      assert.strictEqual(row.attempt_count, attempt);
      assert.strictEqual(row.last_error, "The recipient answered HTTP 503.");
      const delay = retryDelays[attempt - 1];
      if (delay === undefined) {
        assert.strictEqual(row.status, "failed");
        break;
      }
      assert.strictEqual(row.status, "retrying");

      // A duplicate message before the delay is over sends nothing, and the cron
      // leaves the delivery alone until then.
      const early = deliveryBatch([id]);
      yield* consumeDeliveries(early.batch);
      assert.deepEqual(early.settled, [`ack ${id}`]);
      assert.strictEqual(recipient.received.length, attempt);
      sent.length = 0;
      yield* TestClock.adjust(delay - 1);
      yield* publishPendingDeliveries();
      assert.notInclude(sent, id);
      yield* TestClock.adjust(1);
      yield* publishPendingDeliveries();
      assert.include(sent, id);
    }

    assert.strictEqual(recipient.received.length, maxDeliveryAttempts);
    assert.isTrue(recipient.received.every(({ deliveryId }) => deliveryId === id));
    const attempts = yield* attemptsOf(id);
    assert.deepEqual(
      attempts.map(({ attempt, outcome }) => [attempt, outcome]),
      Array.from({ length: maxDeliveryAttempts }, (_, index) => [index + 1, "retryable-failure"]),
    );
    sent.length = 0;
    yield* TestClock.adjust("1 day");
    yield* publishPendingDeliveries();
    assert.notInclude(sent, id);
  });
  return withServices(layer, scenario);
});
