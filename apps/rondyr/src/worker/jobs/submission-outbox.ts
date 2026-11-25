import { Clock, Effect, Option, Schema, Tracer } from "effect";

import { QuarantineAtIntake } from "../../domain/submissions/quarantine-at-intake.command.ts";
import { RequestClassification } from "../../domain/submissions/request-classification.command.ts";
import { Submission } from "../../domain/submissions/submission.aggregate.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";
import { ClassificationQueue } from "../ports/classification-queue.ts";
import { Outbox, type OutboxLease, type StuckScope } from "../ports/outbox.ts";

const Message = Schema.Struct({ submissionId: SubmissionId });

const decodeMessage = Schema.decodeUnknownEffect(Message);

// A claimed event stays leased for a minute; a published event that nobody has
// handed off after five minutes is published again.
const leaseFor = (now: number): OutboxLease => ({
  now,
  until: now + 60_000,
  republishBefore: now - 300_000,
});

/**
 * After this many publications without a hand-off, about an hour, the Cron
 * stops republishing an event. It stays in D1 with its submission until a
 * member retries it by hand.
 */
export const maxPublications = 12;

const publishClaimed = Effect.fnUntraced(function* (
  lease: OutboxLease,
  events: ReadonlyArray<SubmissionId>,
) {
  if (events.length === 0) return;
  const outbox = yield* Outbox;
  const queue = yield* ClassificationQueue;
  yield* queue.send(events);
  yield* outbox.markPublished(lease, events);
});

/** Cron path: set aside the events that reached the limit, then publish up to 100 due events. */
export const publishPendingSubmissions = Effect.fn("Outbox.publish")(function* () {
  const outbox = yield* Outbox;
  const now = yield* Clock.currentTimeMillis;
  const lease = leaseFor(now);
  const { claimed, stuck } = yield* outbox.claimDue(lease, 100, maxPublications);
  yield* Effect.annotateCurrentSpan({
    "outbox.claimed": claimed.length,
    "outbox.stuck": stuck.length,
  });
  for (const submissionId of stuck) {
    yield* Effect.logError("Outbox event stuck", {
      submissionId,
      publications: maxPublications,
    });
  }
  yield* publishClaimed(lease, claimed);
});

/**
 * Direct path after intake: publish one submission's event with the cron's lease,
 * so the two paths never publish the same event at the same time.
 */
export const publishSubmission = Effect.fn("Outbox.publishSubmission")(function* (
  submissionId: SubmissionId,
) {
  yield* Effect.annotateCurrentSpan({ submissionId });
  const outbox = yield* Outbox;
  const now = yield* Clock.currentTimeMillis;
  const lease = leaseFor(now);
  const events = yield* outbox.claim(lease, submissionId);
  yield* Effect.annotateCurrentSpan({ "outbox.published": events.length });
  yield* publishClaimed(lease, events);
});

/**
 * Retry a stuck event by hand: its publication count goes back to zero and it
 * is published at once. The Cron publishes it if this publication fails.
 */
export const retryStuckSubmission = Effect.fn("Outbox.retryStuck")(function* (scope: StuckScope) {
  const outbox = yield* Outbox;
  yield* outbox.retryStuck(scope);
  yield* Effect.logInfo("Stuck outbox event retried by hand", {
    submissionId: scope.submissionId,
  });
  yield* publishSubmission(scope.submissionId).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Direct outbox publication failed", {
        submissionId: scope.submissionId,
        tag: error._tag,
      }),
    ),
    Effect.ignore,
  );
});

export const consumeSubmissions = Effect.fn("Outbox.consume")(function* (batch: MessageBatch) {
  const submissions = yield* Submission;
  const outbox = yield* Outbox;
  for (const message of batch.messages) {
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const { submissionId } = yield* decodeMessage(message.body);
        const pending = yield* outbox.pendingHandoff(submissionId);
        if (Option.isNone(pending)) return;

        // Intake stored the reason with the submission, so a redelivered message or a
        // republished event sends the same command, which the command ID deduplicates.
        const { organizationId, intakeReason, intakeTrace } = pending.value;
        const commandId = `submission-received:${submissionId}`;
        const links = Option.isSome(intakeTrace)
          ? [{ span: Tracer.externalSpan(intakeTrace.value), attributes: { relation: "intake" } }]
          : [];
        const handoff = Effect.gen(function* () {
          yield* Option.match(intakeReason, {
            onNone: () =>
              submissions.send(submissionId, RequestClassification.make({ organizationId }), {
                commandId,
              }),
            onSome: (reason) =>
              submissions.send(submissionId, QuarantineAtIntake.make({ organizationId, reason }), {
                commandId,
              }),
          });
          const now = yield* Clock.currentTimeMillis;
          yield* outbox.markHandedOff(submissionId, now);
        }).pipe(
          Effect.withSpan("Outbox.handoff", {
            attributes: {
              submissionId,
              organizationId,
              "outbox.command": Option.isSome(intakeReason)
                ? "QuarantineAtIntake"
                : "RequestClassification",
              ...(Option.isSome(intakeReason) && { "intake.reason": intakeReason.value }),
            },
            links,
          }),
        );
        yield* handoff;
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
