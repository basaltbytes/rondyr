import { z } from "astro/zod";

import { AutoReply } from "./auto-reply.ts";
import { FlatFields } from "./fields.ts";
import { attemptLeaseMs, retryDelayMs, retryWindowMs, type SendOutcome } from "./retry.ts";

/**
 * `pending` waits for its next attempt, `failed` will not be sent again
 * without the Retry action, and `unlinked` belongs to an EmDash form that has
 * no Rondyr form yet.
 */
export const QueueState = z.enum(["pending", "failed", "unlinked"]);
export type QueueState = z.infer<typeof QueueState>;

/**
 * A submission waiting for Rondyr, stored under its submission ID, which is
 * also the `Idempotency-Key` of every attempt. Times are Unix milliseconds.
 */
export const QueueEntry = z.object({
  formSlug: z.string().min(1),
  fields: FlatFields,
  state: QueueState,
  attempts: z.number().int().min(0),
  enqueuedAt: z.number().int(),
  /** When the entry is due. While an attempt holds the entry, the end of its lease. */
  nextAttemptAt: z.number().int(),
  /** The last HTTP status from Rondyr, or null before any answer or after a network error. */
  lastStatus: z.number().int().nullable(),
  /** The auto-reply that the forms plugin held for a form linked to a Rondyr form, if any. */
  autoReply: AutoReply.optional(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

/**
 * A new entry is due at once: the attempt that runs right after the visitor's
 * response claims it. If that attempt never runs, the cron finds it due.
 */
export function newEntry(
  formSlug: string,
  fields: FlatFields,
  now: number,
  autoReply: AutoReply | null = null,
): QueueEntry {
  const entry: QueueEntry = {
    formSlug,
    fields,
    state: "pending",
    attempts: 0,
    enqueuedAt: now,
    nextAttemptAt: now,
    lastStatus: null,
  };
  if (autoReply !== null) entry.autoReply = autoReply;
  return entry;
}

/** Whether an attempt may start now. */
export function isDue(entry: QueueEntry, now: number): boolean {
  return entry.state === "pending" && entry.nextAttemptAt <= now;
}

/**
 * The entry while one attempt holds it: no other attempt finds it due until
 * the lease ends. An attempt that dies leaves the entry due again then.
 */
export function claimed(entry: QueueEntry, now: number): QueueEntry {
  return { ...entry, nextAttemptAt: now + attemptLeaseMs };
}

/** The entry after an attempt, or `null` when Rondyr stored it and the entry goes. */
export function afterAttempt(entry: QueueEntry, outcome: SendOutcome, now: number) {
  if (outcome.kind === "accepted") return null;
  const attempts = entry.attempts + 1;
  if (outcome.kind === "refused") {
    return { ...entry, state: "failed" as const, attempts, lastStatus: outcome.status };
  }
  const expired = now - entry.enqueuedAt >= retryWindowMs;
  return {
    ...entry,
    state: expired ? ("failed" as const) : ("pending" as const),
    attempts,
    nextAttemptAt: now + retryDelayMs(attempts),
    lastStatus: outcome.status,
  };
}

/** An entry whose EmDash form has no Rondyr form: it waits until one is linked. */
export function unlinked(entry: QueueEntry): QueueEntry {
  return { ...entry, state: "unlinked" };
}

/**
 * The Retry action, or a form newly linked: the entry is due now, with a new
 * seven-day window. A pending entry does not change.
 */
export function retried(entry: QueueEntry, now: number): QueueEntry {
  if (entry.state === "pending") return entry;
  return { ...entry, state: "pending", attempts: 0, enqueuedAt: now, nextAttemptAt: now };
}
