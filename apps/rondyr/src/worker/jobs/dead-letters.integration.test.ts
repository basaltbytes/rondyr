import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it, vi } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { testOrigin as origin } from "../../../tests/integration/auth-fixture.ts";

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

const readEntries = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ message: Schema.Array(Schema.Unknown) })),
);
// The Worker logs the message, then its annotations as a second entry.
const readDeadLetter = Schema.decodeUnknownEffect(
  Schema.Struct({
    queue: Schema.Literals(["classification", "delivery"]),
    messageId: Schema.String,
    attempts: Schema.Int,
    submissionId: Schema.optionalKey(Schema.String),
    deliveryId: Schema.optionalKey(Schema.String),
  }),
);

const readJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isText = Schema.is(Schema.String);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const workerLogs = Effect.promise(() =>
  env.WORKER_LOGS.fetch(`${origin}/`).then((response) => response.text()),
);

/** The annotations of each `Queue message dead-lettered` entry, in order. */
const deadLetterLogs = Effect.gen(function* () {
  const entries = yield* workerLogs.pipe(Effect.flatMap(readJson), Effect.flatMap(readEntries));
  return yield* Effect.forEach(
    entries.flatMap((entry, index) => {
      const [text] = entry.message;
      const annotations = entries[index + 1]?.message[0];
      return isText(text) && text.endsWith("Queue message dead-lettered") ? [annotations] : [];
    }),
    (annotations) => readDeadLetter(annotations),
  );
});

const waitForDeadLetters = (count: number) =>
  Effect.promise(() =>
    vi.waitFor(
      () =>
        Effect.runPromise(deadLetterLogs).then((logs) => {
          assert.lengthOf(logs, count);
        }),
      { timeout: 10_000, interval: 100 },
    ),
  );

it.live(
  "logs and acknowledges each dead-lettered message, duplicates included, without replaying it",
  () =>
    Effect.gen(function* () {
      const submissionId = "6a1f0c7e-2b84-4d9a-9c3e-0f5b7d21a8e4";
      const deliveryId = "c2d4e6f8-1a3b-4c5d-8e7f-9a0b1c2d3e4f";
      const marker = "dead-letter-private-field-3e91d0";
      const fields = yield* encodeJson({ message: marker });
      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('dlq-org', 'Dead letters')"),
          env.DB.prepare(
            "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('dlq-form', 'dlq-org', 'dlq', 'Dead letters')",
          ),
          env.DB.prepare(
            "INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES (?, 'dlq-org', 'dlq-form', ?, 0)",
          ).bind(submissionId, fields),
          env.DB.prepare(
            "INSERT INTO outbox_events (submission_id, publication_count, stuck_at) VALUES (?, 12, 1)",
          ).bind(submissionId),
        ]),
      );

      // Queues delivers at least once: the same message can reach a dead-letter queue twice.
      for (let copy = 0; copy < 2; copy += 1) {
        yield* Effect.promise(() => env.CLASSIFICATION_DEAD_LETTER_QUEUE.send({ submissionId }));
        yield* Effect.promise(() => env.DELIVERY_DEAD_LETTER_QUEUE.send({ deliveryId }));
      }
      yield* Effect.promise(() =>
        env.CLASSIFICATION_DEAD_LETTER_QUEUE.send({ unexpected: marker }),
      );

      yield* waitForDeadLetters(5);
      const logs = yield* deadLetterLogs;
      const ofSubmission = logs.filter((log) => log.submissionId === submissionId);
      const ofDelivery = logs.filter((log) => log.deliveryId === deliveryId);
      assert.deepEqual(
        ofSubmission.map(({ queue, attempts }) => ({ queue, attempts })),
        [
          { queue: "classification", attempts: 1 },
          { queue: "classification", attempts: 1 },
        ],
      );
      assert.deepEqual(
        ofDelivery.map(({ queue, attempts }) => ({ queue, attempts })),
        [
          { queue: "delivery", attempts: 1 },
          { queue: "delivery", attempts: 1 },
        ],
      );
      // Each copy is a message of its own, with its own ID.
      assert.lengthOf(new Set(logs.map(({ messageId }) => messageId)), 5);
      // The message that does not decode is logged by its queue message ID only.
      const unreadable = logs.filter(
        (log) => log.submissionId === undefined && log.deliveryId === undefined,
      );
      assert.deepEqual(
        unreadable.map(({ queue }) => queue),
        ["classification"],
      );
      const text = yield* workerLogs;
      assert.notInclude(text, marker);

      // D1 stays authoritative: nothing hands the event off or classifies it.
      const outbox = yield* Effect.promise(() =>
        env.DB.prepare(
          "SELECT handed_off_at, publication_count, stuck_at FROM outbox_events WHERE submission_id = ?",
        )
          .bind(submissionId)
          .first(),
      );
      assert.deepEqual(outbox, { handed_off_at: null, publication_count: 12, stuck_at: 1 });
      const inbox = yield* Effect.promise(() =>
        env.DB.prepare("SELECT COUNT(*) AS count FROM submission_inbox WHERE submission_id = ?")
          .bind(submissionId)
          .first("count"),
      );
      assert.strictEqual(inbox, 0);

      // An acknowledged message is not delivered again.
      yield* Effect.sleep("1 second");
      const again = yield* deadLetterLogs;
      assert.lengthOf(again, 5);
    }),
  30_000,
);
