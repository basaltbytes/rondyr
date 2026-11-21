import { z } from "astro/zod";

import { FlatFields } from "./fields.ts";
import { retryDelayMs, retryWindowMs, type SendOutcome } from "./retry.ts";

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
  nextAttemptAt: z.number().int(),
  /** The last HTTP status from Rondyr, or null before any answer or after a network error. */
  lastStatus: z.number().int().nullable(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

export function newEntry(formSlug: string, fields: FlatFields, now: number): QueueEntry {
  // The first attempt runs right after the response; the cron picks the entry
  // up a minute later only if that attempt did not settle it.
  return {
    formSlug,
    fields,
    state: "pending",
    attempts: 0,
    enqueuedAt: now,
    nextAttemptAt: now + retryDelayMs(1),
    lastStatus: null,
  };
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
