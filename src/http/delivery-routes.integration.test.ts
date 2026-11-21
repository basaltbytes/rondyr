import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import {
  Clock,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import { verifyRondyrWebhook } from "../../docs/examples/verify-webhook.ts";
import { testSecretsKey } from "../../tests/integration/auth-fixture.ts";
import { secretCipherLayer } from "../adapters/crypto/secret-cipher.ts";
import { deliveryHistoryLive } from "../adapters/database/delivery-history.ts";
import { deliveryStoreLive } from "../adapters/database/delivery-store.ts";
import { notificationTargetsLive } from "../adapters/database/notification-targets.ts";
import { organizationDirectoryLive } from "../adapters/database/organization-directory.ts";
import { emailSenderLayer } from "../adapters/email/email-sender.ts";
import { notificationProvidersLive } from "../adapters/notifications/notification-providers.ts";
import { testNotificationProvider } from "../adapters/notifications/test-notification-provider.ts";
import { DeliveryId } from "../domain/deliveries/delivery.ts";
import { EmailAddress, parseEmailRecipients } from "../domain/deliveries/email.ts";
import { DeliveryRecord, TargetTestResult } from "../domain/deliveries/history.ts";
import { parseWebhookUrl } from "../domain/deliveries/webhook-destination.ts";
import { testWebhookFields, WebhookTestPayload } from "../domain/deliveries/webhook.ts";
import { DeliveryScheduler } from "../domain/submissions/delivery-scheduler.external.ts";
import { SubmissionFields } from "../domain/submissions/submission-fields.ts";
import { OrganizationId, SubmissionId, UserId } from "../domain/submissions/submission.id.ts";
import { Authentication } from "../ports/authentication.ts";
import { DeliveryQueue } from "../ports/delivery-queue.ts";
import { NotificationProvider } from "../ports/notification-provider.ts";
import { NotificationTargets, type FormScope } from "../ports/notification-targets.ts";
import {
  consumeDeliveries,
  deliverySchedulerLive,
  publishPendingDeliveries,
} from "../jobs/delivery-outbox.ts";
import { deliveryRoutes } from "./delivery-routes.ts";
import { targetRoutes } from "./target-routes.ts";

const origin = "https://rondyr.test";
const contact = { email: "customer@example.test", message: "Is there room in the pottery class?" };

const Received = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
});
const ResendEmail = Schema.Struct({
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
});
const readReceived = Schema.decodeUnknownEffect(Schema.Array(Received));
const readIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: DeliveryId })));
const readHistory = Schema.decodeUnknownEffect(Schema.Array(DeliveryRecord));
const readTestResult = Schema.decodeUnknownEffect(TargetTestResult);
const readTestPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(WebhookTestPayload));
const readJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const readResendEmail = Schema.decodeUnknownEffect(Schema.fromJsonString(ResendEmail));
const encodeFields = Schema.encodeEffect(Schema.fromJsonString(SubmissionFields));

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

/** The account is the `x-test-user` header of the request; without it, nobody is signed in. */
const signedIn = Layer.succeed(Authentication, {
  userId: (request) => Effect.succeed(request.headers.get("x-test-user")),
  handle: () => Effect.die("The routes under test do not proxy Better Auth"),
  setup: () => Effect.die("The routes under test do not create accounts"),
});

const cipher = secretCipherLayer(Effect.succeedSome(Redacted.make(testSecretsKey)));
const emailSender = emailSenderLayer(
  Effect.succeed({
    RESEND_API_KEY: Redacted.make("re_delivery_routes_test_key"),
    RONDYR_EMAIL_FROM: EmailAddress.make("forms@rondyr.test"),
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

/** Every request goes to the receiver fixture, which passes api.resend.com on to the Resend fixture. */
const outboundFetch: typeof globalThis.fetch = (input, init) =>
  env.WEBHOOK_RECEIVER.fetch(input, init);

/**
 * D1, the real providers behind the fixtures, and a queue that records what it
 * is sent, so each test runs the consumer itself.
 */
function services(provider = notificationProvidersLive) {
  const sent: Array<DeliveryId> = [];
  const queue = Layer.succeed(DeliveryQueue, {
    send: (deliveryIds) =>
      Effect.sync(() => {
        sent.push(...deliveryIds);
      }),
  });
  const stored = Layer.mergeAll(deliveryStoreLive, queue);
  const layer = Layer.mergeAll(
    signedIn,
    organizationDirectoryLive,
    deliveryHistoryLive,
    stored,
    deliverySchedulerLive.pipe(Layer.provide(stored)),
    Layer.mergeAll(provider, notificationTargetsLive).pipe(
      Layer.provide(Layer.mergeAll(cipher, emailSender)),
    ),
    Layer.succeed(FetchHttpClient.Fetch, outboundFetch),
  );
  return { sent, layer };
}

type Services = Layer.Success<ReturnType<typeof services>["layer"]>;
type Call = (user: string | null, path: string, method?: string) => Effect.Effect<Response>;

/** Build the services and the routes once, and give the scenario a way to call them. */
const withRoutes = <A, E>(
  layer: Layer.Layer<Services>,
  scenario: (call: Call) => Effect.Effect<A, E, Services>,
) =>
  Effect.gen(function* () {
    const built = yield* Layer.build(layer);
    // With the target routes, as in the Worker: POST …/targets/:targetId/:action is theirs.
    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.mergeAll(deliveryRoutes, targetRoutes).pipe(Layer.provide(HttpServer.layerServices)),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const call = (user: string | null, path: string, method = "GET") =>
      Effect.promise(() => {
        const headers = new Headers({ origin });
        if (user !== null) headers.set("x-test-user", user);
        return handler(new Request(new URL(path, origin), { method, headers }), built);
      });
    return yield* scenario(call).pipe(Effect.provideContext(built));
  }).pipe(Effect.scoped);

/** A member `<name>-user` of `<name>-org`, whose form `<name>` has the given submissions. */
const seedForm = Effect.fnUntraced(function* (
  name: string,
  submissionIds: ReadonlyArray<SubmissionId>,
) {
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
      ...submissionIds.map((id) =>
        env.DB.prepare(
          "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, ?, ?, ?, 0)",
        ).bind(id, `${name}-org`, `${name}-form`, fields),
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

const addWebhook = Effect.fnUntraced(function* (form: FormScope, url: string) {
  const targets = yield* NotificationTargets;
  const accepted = Result.getOrElse(parseWebhookUrl(url, Option.none()), () =>
    assert.fail(`${url} is refused`),
  );
  return yield* targets.createWebhook(form, accepted);
});

const addEmail = Effect.fnUntraced(function* (form: FormScope, address: string) {
  const targets = yield* NotificationTargets;
  const recipients = Result.getOrElse(parseEmailRecipients([address]), () =>
    assert.fail(`${address} is refused`),
  );
  return yield* targets.createEmail(form, recipients, "en");
});

/** Run the `Delivery` policy's scheduler for an acceptance now. */
const deliverAccepted = Effect.fnUntraced(function* (form: FormScope, submissionId: SubmissionId) {
  const scheduler = yield* DeliveryScheduler;
  const acceptedAt = yield* Clock.currentTimeMillis;
  yield* scheduler.schedule({ submissionId, organizationId: form.organizationId, acceptedAt });
});

/** Run the consumer once on a batch with one message per delivery ID. */
function consume(deliveryIds: ReadonlyArray<DeliveryId>) {
  const messages = deliveryIds.map((deliveryId, index): Message => ({
    id: `message-${index}`,
    timestamp: DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    attempts: 1,
    body: { deliveryId },
    ack: () => {},
    retry: () => {},
  }));
  return consumeDeliveries({
    queue: "rondyr-delivery",
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => {},
    retryAll: () => {},
  });
}

const deliveryIdsOf = Effect.fnUntraced(function* (submissionId: SubmissionId) {
  const rows = yield* Effect.promise(() =>
    env.DB.prepare("SELECT id FROM deliveries WHERE submission_id = ?").bind(submissionId).all(),
  );
  const ids = yield* readIds(rows.results);
  return ids.map(({ id }) => id);
});

const historyOf = Effect.fnUntraced(function* (response: Response) {
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  const body = yield* Effect.promise(() => response.json());
  return yield* readHistory(body);
});

/** Send a test to a target, as the member of `<organization>-org`. */
const testTarget = (call: Call, organization: string, targetId: string) =>
  call(
    `${organization}-user`,
    `/api/organizations/${organization}-org/targets/${targetId}/test`,
    "POST",
  );

const testResult = Effect.fnUntraced(function* (
  call: Call,
  organization: string,
  targetId: string,
) {
  const response = yield* testTarget(call, organization, targetId);
  assert.strictEqual(response.status, 200);
  const body = yield* Effect.promise(() => response.json());
  return yield* readTestResult(body);
});

const labelOf = (record: typeof DeliveryRecord.Type) =>
  record.destination.type === "webhook"
    ? record.destination.url
    : record.destination.recipients.join(", ");

const recordFor = (records: ReadonlyArray<typeof DeliveryRecord.Type>, label: string) => {
  const record = records.find((item) => labelOf(item) === label);
  if (record === undefined) return assert.fail(`No delivery to ${label}`);
  return record;
};

const webhookRequests = Effect.fnUntraced(function* (prefix: string) {
  const response = yield* Effect.promise(() =>
    env.WEBHOOK_RECEIVER.fetch(
      `https://receiver.test/__received?prefix=${encodeURIComponent(prefix)}`,
    ),
  );
  const json = yield* Effect.promise(() => response.json());
  return yield* readReceived(json);
});

const emailRequests = Effect.fnUntraced(function* (recipient: string) {
  const response = yield* Effect.promise(() =>
    env.RESEND_FIXTURE.fetch(
      `https://api.resend.com/__received?recipient=${encodeURIComponent(recipient)}`,
    ),
  );
  const json = yield* Effect.promise(() => response.json());
  return yield* readReceived(json);
});

it.live("lists each delivery of a message with its destination, status and attempts", () => {
  const { layer } = services();
  const submissionId = SubmissionId.make("7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e01");
  const quiet = SubmissionId.make("7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e02");
  const unknown = SubmissionId.make("7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e03");
  return withRoutes(layer, (call) =>
    Effect.gen(function* () {
      const form = yield* seedForm("history", [submissionId, quiet]);
      const ok = "https://hooks.example.com/t/history/ok";
      const flaky = "https://hooks.example.com/t/history/fail-once";
      const refusing = "https://hooks.example.com/t/history/bad-request";
      const team = "history-team@example.test";
      yield* addWebhook(form, ok);
      yield* addWebhook(form, flaky);
      yield* addWebhook(form, refusing);
      yield* addEmail(form, team);
      yield* deliverAccepted(form, submissionId);
      yield* Effect.flatMap(deliveryIdsOf(submissionId), consume);

      const path = `/api/organizations/history-org/submissions/${submissionId}/deliveries`;
      const response = yield* call("history-user", path);
      const text = yield* Effect.promise(() => response.clone().text());
      // The history contains states and summaries, never the fields of the message.
      assert.notInclude(text, contact.message);
      const records = yield* historyOf(response);
      assert.sameDeepMembers(
        records.map((record) => [
          record.destination.type,
          labelOf(record),
          record.status,
          record.attemptCount,
          record.lastError,
          record.attempts.map(({ attempt, outcome, error }) => [attempt, outcome, error]),
        ]),
        [
          ["webhook", ok, "delivered", 1, null, [[1, "delivered", null]]],
          [
            "webhook",
            flaky,
            "retrying",
            1,
            "The recipient answered HTTP 500.",
            [[1, "retryable-failure", "The recipient answered HTTP 500."]],
          ],
          [
            "webhook",
            refusing,
            "failed",
            1,
            "The recipient answered HTTP 400.",
            [[1, "permanent-failure", "The recipient answered HTTP 400."]],
          ],
          ["email", team, "delivered", 1, null, [[1, "delivered", null]]],
        ],
      );
      for (const record of records) {
        for (const attempt of record.attempts) {
          assert.isAtLeast(attempt.finishedAt ?? -1, attempt.startedAt);
        }
      }
      // Only a delivery waiting for a retry has a next attempt, one minute after the first.
      const retrying = recordFor(records, flaky);
      assert.strictEqual(retrying.nextAttemptAt, (retrying.attempts[0]?.finishedAt ?? 0) + 60_000);
      assert.deepEqual(
        records.filter((record) => record !== retrying).map(({ nextAttemptAt }) => nextAttemptAt),
        [null, null, null],
      );

      // A message without delivery has an empty history; an unknown one answers 404.
      const none = yield* call(
        "history-user",
        `/api/organizations/history-org/submissions/${quiet}/deliveries`,
      ).pipe(Effect.flatMap(historyOf));
      assert.deepEqual(none, []);
      const missing = yield* call(
        "history-user",
        `/api/organizations/history-org/submissions/${unknown}/deliveries`,
      );
      const anonymous = yield* call(null, path);
      assert.deepEqual([missing.status, anonymous.status], [404, 401]);
    }),
  );
});

it.live("retries a failed delivery once, with the same id and its whole history", () => {
  const { layer, sent } = services();
  const submissionId = SubmissionId.make("7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e11");
  return withRoutes(layer, (call) =>
    Effect.gen(function* () {
      const form = yield* seedForm("retried", [submissionId]);
      // Resend answers 422 to the first request with a key, then 200.
      const refusedOnce = "once-422@retried.example.test";
      const ok = "https://hooks.example.com/t/retried/ok";
      const flaky = "https://hooks.example.com/t/retried/fail-once";
      yield* addEmail(form, refusedOnce);
      yield* addWebhook(form, ok);
      yield* addWebhook(form, flaky);
      yield* deliverAccepted(form, submissionId);
      yield* Effect.flatMap(deliveryIdsOf(submissionId), consume);

      const deliveries = `/api/organizations/retried-org/submissions/${submissionId}/deliveries`;
      const before = yield* call("retried-user", deliveries).pipe(Effect.flatMap(historyOf));
      const failed = recordFor(before, refusedOnce);
      assert.deepEqual(
        [failed.status, failed.lastError],
        ["failed", "Resend answered HTTP 422 (validation_error)."],
      );

      // Only a failed delivery can be retried.
      const refused = yield* Effect.all([
        call("retried-user", `${deliveries}/${recordFor(before, ok).id}/retry`, "POST"),
        call("retried-user", `${deliveries}/${recordFor(before, flaky).id}/retry`, "POST"),
      ]);
      assert.deepEqual(
        refused.map(({ status }) => status),
        [409, 409],
      );

      // Two people retry at the same time: one retry, one publication.
      sent.length = 0;
      const retries = yield* Effect.all(
        [
          call("retried-user", `${deliveries}/${failed.id}/retry`, "POST"),
          call("retried-user", `${deliveries}/${failed.id}/retry`, "POST"),
        ],
        { concurrency: "unbounded" },
      );
      assert.sameMembers(
        retries.map(({ status }) => status),
        [200, 409],
      );
      const accepted = retries.find(({ status }) => status === 200);
      if (accepted === undefined) return assert.fail("Expected one accepted retry");
      const afterRetry = yield* historyOf(accepted);
      const pending = recordFor(afterRetry, refusedOnce);
      assert.deepEqual(
        [pending.id, pending.status, pending.lastError, pending.attemptCount],
        [failed.id, "pending", null, 1],
      );
      assert.deepEqual(sent, [failed.id]);
      // The cron finds nothing to publish: the retry published the delivery.
      yield* publishPendingDeliveries();
      assert.deepEqual(sent, [failed.id]);

      // The queue delivers the message twice: one attempt.
      yield* consume([failed.id, failed.id]);
      const after = yield* call("retried-user", deliveries).pipe(Effect.flatMap(historyOf));
      const delivered = recordFor(after, refusedOnce);
      assert.deepEqual(
        [delivered.id, delivered.status, delivered.lastError, delivered.attemptCount],
        [failed.id, "delivered", null, 2],
      );
      assert.deepEqual(
        delivered.attempts.map(({ attempt, outcome, error }) => [attempt, outcome, error]),
        [
          [1, "permanent-failure", "Resend answered HTTP 422 (validation_error)."],
          [2, "delivered", null],
        ],
      );
      const requests = yield* emailRequests(refusedOnce);
      assert.deepEqual(
        requests.map(({ headers }) => headers["idempotency-key"]),
        [failed.id, failed.id],
      );
    }),
  );
});

it.live("gives a retried delivery a new series of attempts", () => {
  const { layer } = services();
  const submissionId = SubmissionId.make("7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e21");
  return withRoutes(layer, (call) =>
    Effect.gen(function* () {
      const form = yield* seedForm("series", [submissionId]);
      // Resend answers 500 every time: each attempt is a retryable failure.
      const unavailable = "always-500@series.example.test";
      const target = yield* addEmail(form, unavailable);
      // A delivery that used its six attempts.
      const deliveryId = DeliveryId.make("0d5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a21");
      const error = "Resend answered HTTP 500 (application_error).";
      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare(`
            INSERT INTO deliveries (id, submission_id, target_id, status, attempt_count, last_error,
              next_attempt_at, created_at, updated_at)
            VALUES (?1, ?2, ?3, 'failed', 6, ?4, 0, 0, 0)
          `).bind(deliveryId, submissionId, target.id, error),
          ...Array.from({ length: 6 }, (_, index) =>
            env.DB.prepare(`
              INSERT INTO delivery_attempts (delivery_id, attempt, started_at, finished_at, outcome, error)
              VALUES (?1, ?2, ?2, ?2, 'retryable-failure', ?3)
            `).bind(deliveryId, index + 1, error),
          ),
        ]),
      );
      const deliveries = `/api/organizations/series-org/submissions/${submissionId}/deliveries`;
      const retried = yield* call("series-user", `${deliveries}/${deliveryId}/retry`, "POST");
      assert.strictEqual(retried.status, 200);
      yield* consume([deliveryId]);

      // The seventh attempt is the first of its series: the delivery waits one minute.
      const [record] = yield* call("series-user", deliveries).pipe(Effect.flatMap(historyOf));
      if (record === undefined) return assert.fail("Expected the delivery");
      const last = record.attempts.at(-1);
      assert.deepEqual(
        [record.status, record.attemptCount, last?.attempt, last?.outcome],
        ["retrying", 7, 7, "retryable-failure"],
      );
      assert.strictEqual(record.nextAttemptAt, (last?.finishedAt ?? 0) + 60_000);
    }),
  );
});

it.live("sends a marked test message to each kind of target and stores nothing", () => {
  const { layer } = services();
  return withRoutes(layer, (call) =>
    Effect.gen(function* () {
      const form = yield* seedForm("probe", []);
      const hook = yield* addWebhook(form, "https://hooks.example.com/t/probe/ok");
      const refusing = yield* addWebhook(form, "https://hooks.example.com/t/probe/bad-request");
      const team = "probe-team@example.test";
      const unavailable = "always-500@probe.example.test";
      const email = yield* addEmail(form, team);
      const failingEmail = yield* addEmail(form, unavailable);
      // A stored URL that the destination rules refuse is refused for a test too.
      yield* Effect.promise(() =>
        env.DB.prepare(`
          INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
          VALUES ('probe-private', 'probe-org', 'probe-form', 'webhook',
            '{"url":"https://10.0.0.8/t/probe/private/ok","secret":"v1.a.b","previousSecret":null}', 0)
        `).run(),
      );
      const delivered = yield* testResult(call, "probe", hook.target.id);
      assert.strictEqual(delivered.outcome, "delivered");
      const [request, ...others] = yield* webhookRequests("/t/probe/ok");
      if (request === undefined) return assert.fail("The receiver got no request");
      assert.deepEqual(others, []);
      assert.strictEqual(request.headers["rondyr-delivery-id"], delivered.testId);
      const now = yield* Clock.currentTimeMillis;
      const verified = yield* Effect.promise(() =>
        verifyRondyrWebhook(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
          }),
          hook.secret,
          now,
        ),
      );
      assert.strictEqual(verified, request.body);
      const payload = yield* readTestPayload(request.body);
      const json = yield* readJson(request.body);
      assert.deepEqual(json, {
        version: 1,
        type: "test",
        deliveryId: delivered.testId,
        submission: {
          id: delivered.testId,
          receivedAt: DateTime.formatIso(payload.submission.receivedAt),
          fields: testWebhookFields,
        },
        form: { id: "probe", name: "Form probe" },
      });

      const mailed = yield* testResult(call, "probe", email.id);
      assert.strictEqual(mailed.outcome, "delivered");
      const [message, ...more] = yield* emailRequests(team);
      if (message === undefined) return assert.fail("Resend got no request");
      assert.deepEqual(more, []);
      assert.strictEqual(message.headers["idempotency-key"], mailed.testId);
      const sentEmail = yield* readResendEmail(message.body);
      assert.deepEqual([sentEmail.to, sentEmail.subject], [[team], "Test message: Form probe"]);
      assert.include(sentEmail.text, "Test message sent from the Rondyr dashboard");
      assert.include(sentEmail.text, `Test ID: ${mailed.testId}`);

      const failures = yield* Effect.all([
        testResult(call, "probe", refusing.target.id),
        testResult(call, "probe", failingEmail.id),
        testResult(call, "probe", "probe-private"),
      ]);
      assert.deepEqual(
        failures.map((result) => ({ ...result, testId: "" })),
        [
          {
            testId: "",
            outcome: "permanent-failure",
            summary: "The recipient answered HTTP 400.",
          },
          {
            testId: "",
            outcome: "retryable-failure",
            summary: "Resend answered HTTP 500 (application_error).",
          },
          {
            testId: "",
            outcome: "permanent-failure",
            summary: "The webhook URL is refused: reserved-address.",
          },
        ],
      );
      const privateRequests = yield* webhookRequests("/t/probe/private/");
      assert.deepEqual(privateRequests, []);

      // A test creates no submission, no delivery and no attempt.
      const stored = yield* Effect.promise(() =>
        env.DB.prepare(`
          SELECT
            (SELECT COUNT(*) FROM submissions WHERE organization_id = 'probe-org') AS submissions,
            (SELECT COUNT(*) FROM deliveries d JOIN notification_targets t ON t.id = d.target_id
              WHERE t.organization_id = 'probe-org') AS deliveries,
            (SELECT COUNT(*) FROM delivery_attempts a JOIN deliveries d ON d.id = a.delivery_id
              JOIN notification_targets t ON t.id = d.target_id
              WHERE t.organization_id = 'probe-org') AS attempts
        `).first(),
      );
      assert.deepEqual(stored, { submissions: 0, deliveries: 0, attempts: 0 });
    }),
  );
});

it.live("runs one test at a time per target", () => {
  let tests = 0;
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  // The first test waits until the scenario releases it.
  const holdFirst = () => {
    tests += 1;
    return tests === 1
      ? Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release))
      : Effect.void;
  };
  const recipient = testNotificationProvider(() => Effect.void, holdFirst);
  const { layer } = services(Layer.succeed(NotificationProvider, recipient.provider));
  return withRoutes(layer, (call) =>
    Effect.gen(function* () {
      const form = yield* seedForm("single", []);
      const first = yield* addWebhook(form, "https://hooks.example.com/t/single/first/ok");
      const second = yield* addWebhook(form, "https://hooks.example.com/t/single/second/ok");
      const running = yield* Effect.forkChild(testTarget(call, "single", first.target.id));
      yield* Deferred.await(started);
      const busy = yield* testTarget(call, "single", first.target.id);
      const other = yield* testTarget(call, "single", second.target.id);
      assert.deepEqual([busy.status, other.status], [409, 200]);
      yield* Deferred.succeed(release, undefined);
      const done = yield* Fiber.join(running);
      const again = yield* testTarget(call, "single", first.target.id);
      assert.deepEqual([done.status, again.status], [200, 200]);
      assert.deepEqual(
        recipient.tested.map(({ target }) => target.id),
        [first.target.id, second.target.id, first.target.id],
      );
    }),
  );
});

it.live("refuses the history, the retry and the test to another organization", () => {
  const { layer, sent } = services();
  const own = SubmissionId.make("7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e31");
  const foreign = SubmissionId.make("7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e32");
  const foreignDelivery = "0d5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a32";
  return withRoutes(layer, (call) =>
    Effect.gen(function* () {
      yield* seedForm("insider", [own]);
      yield* seedForm("outsider", [foreign]);
      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare(`
            INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at)
            VALUES ('outsider-webhook', 'outsider-org', 'outsider-form', 'webhook',
              '{"url":"https://hooks.example.com/t/outsider/ok","secret":"v1.a.b","previousSecret":null}', 0)
          `),
          env.DB.prepare(`
            INSERT INTO deliveries (id, submission_id, target_id, status, attempt_count, last_error,
              next_attempt_at, created_at, updated_at)
            VALUES (?1, ?2, 'outsider-webhook', 'failed', 1, 'The recipient answered HTTP 400.', 0, 0, 0)
          `).bind(foreignDelivery, foreign),
        ]),
      );
      const foreignPath = `/api/organizations/outsider-org/submissions/${foreign}/deliveries`;
      // The account's organization in the path, with another organization's records.
      const mixedPath = `/api/organizations/insider-org/submissions/${foreign}/deliveries`;
      const ownPath = `/api/organizations/insider-org/submissions/${own}/deliveries`;
      const responses = yield* Effect.all([
        call("insider-user", foreignPath),
        call("insider-user", mixedPath),
        call("insider-user", `${foreignPath}/${foreignDelivery}/retry`, "POST"),
        call("insider-user", `${mixedPath}/${foreignDelivery}/retry`, "POST"),
        call("insider-user", `${ownPath}/${foreignDelivery}/retry`, "POST"),
        call(
          "insider-user",
          "/api/organizations/outsider-org/targets/outsider-webhook/test",
          "POST",
        ),
        call(
          "insider-user",
          "/api/organizations/insider-org/targets/outsider-webhook/test",
          "POST",
        ),
      ]);
      assert.deepEqual(
        responses.map(({ status }) => status),
        [404, 404, 404, 404, 404, 404, 404],
      );

      const row = yield* Effect.promise(() =>
        env.DB.prepare("SELECT status, attempt_count FROM deliveries WHERE id = ?")
          .bind(foreignDelivery)
          .first(),
      );
      assert.deepEqual(row, { status: "failed", attempt_count: 1 });
      assert.deepEqual(sent, []);
      const requests = yield* webhookRequests("/t/outsider/");
      assert.deepEqual(requests, []);
      // The member of that organization reads its history.
      const history = yield* call("outsider-user", foreignPath).pipe(Effect.flatMap(historyOf));
      assert.deepEqual(
        history.map(({ id, status }) => [id, status]),
        [[foreignDelivery, "failed"]],
      );
    }),
  );
});
