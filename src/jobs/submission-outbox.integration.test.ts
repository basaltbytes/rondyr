import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Clock, Context, Deferred, Effect, Fiber, Layer, Schema } from "effect";

import { testOrigin as origin } from "../../tests/integration/auth-fixture.ts";
import { submissionIntakeLive } from "../adapters/database/intake.ts";
import { outboxLive } from "../adapters/database/outbox.ts";
import { classificationQueueLive } from "../adapters/queues/classification-queue.ts";
import { SubmissionId } from "../domain/submissions/submission.id.ts";
import { ClassificationQueue, QueueUnavailable } from "../ports/classification-queue.ts";
import { SubmissionIntake } from "../ports/intake.ts";
import { publishPendingSubmissions, publishSubmission } from "./submission-outbox.ts";

const contact = { email: "customer@example.test", message: "Is there room in the pottery class?" };
const adapters = Layer.mergeAll(submissionIntakeLive, outboxLive, classificationQueueLive);
const OutboxRow = Schema.Struct({
  lease_until: Schema.Int,
  published_at: Schema.NullOr(Schema.Int),
  handed_off_at: Schema.NullOr(Schema.Int),
});
const readRow = Schema.decodeUnknownEffect(OutboxRow);
const readAccepted = Schema.decodeUnknownEffect(Schema.Struct({ "submission-id": SubmissionId }));

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const seedForm = (name: string) =>
  Effect.promise(() =>
    env.DB.batch([
      env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(
        `${name}-org`,
        name,
      ),
      env.DB.prepare(
        "INSERT INTO forms (id, organization_id, public_id, name) VALUES (?, ?, ?, ?)",
      ).bind(`${name}-form`, `${name}-org`, name, name),
    ]),
  );

const outboxRow = Effect.fnUntraced(function* (submissionId: SubmissionId) {
  const row = yield* Effect.promise(() =>
    env.DB.prepare(
      "SELECT lease_until, published_at, handed_off_at FROM outbox_events WHERE submission_id = ?",
    )
      .bind(submissionId)
      .first(),
  );
  return yield* readRow(row);
});

// One ClassificationRequested event followed by the quarantine decision, since
// workerd has no Workers AI binding.
const waitForOneClassification = (submissionId: SubmissionId) =>
  Effect.promise(() =>
    vi.waitFor(
      () =>
        env.DB.prepare("SELECT status, version FROM submission_inbox WHERE submission_id = ?")
          .bind(submissionId)
          .first()
          .then((row) => {
            assert.deepEqual(row, { status: "quarantined", version: 2 });
          }),
      { timeout: 15_000, interval: 100 },
    ),
  );

/** The real queue, with a record of the submissions sent through it. */
const recording = (queue: ClassificationQueue["Service"], sent: Array<SubmissionId>) =>
  ClassificationQueue.of({
    send: (submissionIds) =>
      Effect.andThen(
        queue.send(submissionIds),
        Effect.sync(() => {
          sent.push(...submissionIds);
        }),
      ),
  });

it.live(
  "leaves a failed direct publication to the cron once its lease expires",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(adapters);
      const queue = Context.get(services, ClassificationQueue);
      yield* seedForm("outbox-failed");
      const submissionId = yield* Context.get(services, SubmissionIntake).receive(
        "outbox-failed",
        contact,
      );

      const failure = yield* publishSubmission(submissionId).pipe(
        Effect.provideService(ClassificationQueue, {
          send: () => Effect.fail(QueueUnavailable.make()),
        }),
        Effect.provideContext(services),
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "QueueUnavailable");
      const now = yield* Clock.currentTimeMillis;
      const leased = yield* outboxRow(submissionId);
      assert.isNull(leased.published_at);
      assert.isAbove(leased.lease_until, now);

      const sent: Array<SubmissionId> = [];
      const cron = publishPendingSubmissions().pipe(
        Effect.provideService(ClassificationQueue, recording(queue, sent)),
        Effect.provideContext(services),
      );
      yield* cron;
      assert.notInclude(sent, submissionId);

      yield* Effect.promise(() =>
        env.DB.prepare("UPDATE outbox_events SET lease_until = 1 WHERE submission_id = ?")
          .bind(submissionId)
          .run(),
      );
      yield* cron;
      assert.include(sent, submissionId);
      const published = yield* outboxRow(submissionId);
      assert.isNumber(published.published_at);
      assert.strictEqual(published.lease_until, 0);
      yield* waitForOneClassification(submissionId);
    }),
  30_000,
);

it.live(
  "publishes on intake, then the cron skips the published event",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(adapters);
      const queue = Context.get(services, ClassificationQueue);
      yield* seedForm("outbox-direct");
      const response = yield* Effect.promise(() =>
        env.TEST_WORKER.fetch(new URL("/f/outbox-direct", origin), {
          method: "POST",
          body: new URLSearchParams(contact),
        }),
      );
      assert.strictEqual(response.status, 202);
      const body = yield* Effect.promise(() => response.json());
      const { "submission-id": submissionId } = yield* readAccepted(body);

      yield* Effect.promise(() =>
        vi.waitFor(
          () =>
            env.DB.prepare("SELECT published_at FROM outbox_events WHERE submission_id = ?")
              .bind(submissionId)
              .first("published_at")
              .then((publishedAt) => {
                assert.isNumber(publishedAt);
              }),
          { timeout: 5_000, interval: 50 },
        ),
      );
      const sent: Array<SubmissionId> = [];
      yield* publishPendingSubmissions().pipe(
        Effect.provideService(ClassificationQueue, recording(queue, sent)),
        Effect.provideContext(services),
      );
      assert.notInclude(sent, submissionId);
      yield* waitForOneClassification(submissionId);
    }),
  30_000,
);

it.live(
  "keeps the cron away from an event that the direct path has leased",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(adapters);
      const queue = Context.get(services, ClassificationQueue);
      yield* seedForm("outbox-lease");
      const submissionId = yield* Context.get(services, SubmissionIntake).receive(
        "outbox-lease",
        contact,
      );

      const sending = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const direct: Array<SubmissionId> = [];
      const blocked = ClassificationQueue.of({
        send: (submissionIds) =>
          Deferred.succeed(sending, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(recording(queue, direct).send(submissionIds)),
          ),
      });
      const publication = yield* publishSubmission(submissionId).pipe(
        Effect.provideService(ClassificationQueue, blocked),
        Effect.provideContext(services),
        Effect.forkChild,
      );
      yield* Deferred.await(sending);

      const cron: Array<SubmissionId> = [];
      yield* publishPendingSubmissions().pipe(
        Effect.provideService(ClassificationQueue, recording(queue, cron)),
        Effect.provideContext(services),
      );
      assert.notInclude(cron, submissionId);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(publication);
      assert.deepEqual(direct, [submissionId]);
      const published = yield* outboxRow(submissionId);
      assert.isNumber(published.published_at);
      yield* waitForOneClassification(submissionId);
    }),
  30_000,
);
