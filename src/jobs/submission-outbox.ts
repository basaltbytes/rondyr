import { Clock, Effect, Schema } from "effect";

import { d1, database } from "../adapters/database/d1.ts";
import { RequestClassification } from "../domain/submissions/request-classification.command.ts";
import { Submission } from "../domain/submissions/submission.aggregate.ts";
import { OrganizationId, SubmissionId } from "../domain/submissions/submission.id.ts";

const Message = Schema.Struct({ submissionId: SubmissionId });
const Claim = Schema.Struct({ submission_id: SubmissionId });
const Organization = Schema.Struct({ organization_id: OrganizationId });

const decodeMessage = Schema.decodeUnknownEffect(Message);
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(SubmissionId)));
const decodeClaims = Schema.decodeUnknownEffect(Schema.Array(Claim));
const decodeOrganization = Schema.decodeUnknownEffect(Schema.NullOr(Organization));

export const publishPendingSubmissions = Effect.fn("Outbox.publish")(function* () {
  const db = yield* database;
  const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
  const now = yield* Clock.currentTimeMillis;
  const lease = now + 60_000;
  const claims = yield* d1(() =>
    db
      .prepare(`
    UPDATE outbox_events SET lease_until = ?
    WHERE submission_id IN (
      SELECT submission_id FROM outbox_events WHERE handed_off_at IS NULL
        AND lease_until <= ? AND (published_at IS NULL OR published_at <= ?)
      ORDER BY lease_until, submission_id LIMIT 100
    )
    RETURNING submission_id
  `)
      .bind(lease, now, now - 300_000)
      .all(),
  );
  const events = yield* decodeClaims(claims.results);
  if (events.length === 0) return;

  yield* d1(() =>
    env.CLASSIFICATION_QUEUE.sendBatch(
      events.map(({ submission_id }) => ({ body: { submissionId: submission_id } })),
    ),
  );
  const ids = yield* encodeIds(events.map(({ submission_id }) => submission_id));
  yield* d1(() =>
    db
      .prepare(`
    UPDATE outbox_events SET published_at = ?, lease_until = 0
    WHERE lease_until = ? AND submission_id IN (SELECT value FROM json_each(?))
  `)
      .bind(now, lease, ids)
      .run(),
  );
});

export const consumeSubmissions = Effect.fn("Outbox.consume")(function* (batch: MessageBatch) {
  const submissions = yield* Submission;
  const db = yield* database;
  for (const message of batch.messages) {
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const { submissionId } = yield* decodeMessage(message.body);
        const row = yield* d1(() =>
          db
            .prepare(`
        SELECT organization_id FROM outbox_events JOIN submissions ON submissions.id = outbox_events.submission_id
        WHERE submission_id = ? AND handed_off_at IS NULL
      `)
            .bind(submissionId)
            .first(),
        );
        const pending = yield* decodeOrganization(row);
        if (pending === null) return;

        yield* submissions.send(
          submissionId,
          RequestClassification.make({ organizationId: pending.organization_id }),
          { commandId: `submission-received:${submissionId}` },
        );
        const now = yield* Clock.currentTimeMillis;
        yield* d1(() =>
          db
            .prepare(`
        UPDATE outbox_events SET handed_off_at = ?
        WHERE submission_id = ? AND handed_off_at IS NULL
      `)
            .bind(now, submissionId)
            .run(),
        );
      }),
    );
    if (result._tag === "Success") {
      message.ack();
    } else {
      yield* Effect.logWarning("Classification queue message requires retry", {
        tag: result.failure._tag,
      });
      message.retry();
    }
  }
});
