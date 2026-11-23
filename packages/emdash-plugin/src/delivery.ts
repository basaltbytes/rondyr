import type { PluginContext } from "emdash";

import { afterAttempt, claimed, isDue, retried, unlinked } from "./core/queue.ts";
import { sendOutcome } from "./core/retry.ts";
import { RondyrClient } from "./core/rondyr-client.ts";
import type { ResolvedOptions } from "./options.ts";
import { Store, type OriginRecord, type StorageHost } from "./store.ts";

/**
 * How many due entries one cron run sends. Rondyr takes 30 submissions a
 * minute per form, so a backlog drains at about the rate Rondyr accepts.
 */
const batchSize = 25;

/**
 * A run starts no attempt after this long. With the 30-second timeout of an
 * attempt, a run ends within about a minute and a half, well before EmDash
 * would consider its cron task stuck (10 minutes) and start another run.
 */
const runBudgetMs = 60_000;

/** Rondyr retries a webhook for about nine hours; delivery IDs are kept for 30 days. */
const deliveryMemoryMs = 30 * 24 * 3_600_000;

/**
 * A quarantined message can be accepted at any time, so the origin of each
 * message is kept for a year. A message accepted later is emailed as one of
 * unknown origin.
 */
export const originMemoryMs = 365 * 24 * 3_600_000;

/** What sending needs from a plugin context: storage, a logger and `ctx.http`. */
export interface DeliveryHost extends StorageHost {
  readonly http?: Pick<NonNullable<PluginContext["http"]>, "fetch">;
}

/** The current time in Unix milliseconds; tests pass their own clock. */
export type Clock = () => number;

/** What an attempt did. `skipped`: not due, held by another attempt, or nothing to send with. */
export type AttemptResult = "sent" | "retry" | "failed" | "unlinked" | "skipped";

/**
 * Send one queue entry to Rondyr and record what happened. The attempt first
 * claims the entry with a conditional write, so no other attempt sends it at the
 * same time; the outcome is written against that claim. The entry is deleted
 * only after a `202`, once the submission ID that Rondyr returned is recorded
 * with the entry's EmDash form. Without a token, or before the entry is due, nothing
 * happens. An entry of a form without a Rondyr form becomes `unlinked`.
 */
export async function attempt(
  ctx: DeliveryHost,
  options: ResolvedOptions,
  token: string | null,
  id: string,
  clock: Clock = Date.now,
): Promise<AttemptResult> {
  const http = ctx.http;
  if (token === null || http === undefined) return "skipped";
  const store = new Store(ctx);
  const current = await store.versionedQueueEntry(id);
  if (current === null || !isDue(current.value, clock())) return "skipped";
  const entry = current.value;
  const claim = await store.replaceQueueEntry(id, current.revision, claimed(entry, clock()));
  if (claim === null) return "skipped";

  const link = await store.link(entry.formSlug);
  if (link === null || link.rondyrFormId === null) {
    await store.replaceQueueEntry(id, claim, unlinked(entry));
    return "unlinked";
  }
  const client = new RondyrClient((url, init) => http.fetch(url, init), options.url, token);
  const result = await client.submit(
    link.rondyrFormId,
    entry.fields,
    id,
    entry.declared?.turnstile,
  );
  const next = afterAttempt(entry, sendOutcome(result.status), clock());
  if (next === null) {
    // Recorded before the entry goes: while the entry is pending, the webhook can wait for it.
    const submissionId = result.status === null ? null : result.submissionId;
    if (submissionId === null) {
      ctx.log.warn("Rondyr stored a queued submission without returning its ID", {
        submissionId: id,
      });
    } else {
      const origin: OriginRecord = { formSlug: entry.formSlug, recordedAt: clock() };
      if (entry.autoReply !== undefined) origin.autoReply = entry.autoReply;
      if (entry.declared !== undefined) origin.locale = entry.declared.locale;
      await store.putOrigin(submissionId, origin);
    }
    await store.deleteQueueEntry(id, claim);
    return "sent";
  }
  const written = await store.replaceQueueEntry(id, claim, next);
  // The submission ID, the status and the category of a network error only: the fields stay in storage.
  const details = {
    submissionId: id,
    status: result.status,
    reason: result.status === null ? result.reason : null,
    state: next.state,
  };
  if (next.state === "failed") ctx.log.warn("Rondyr refused a queued submission", details);
  else ctx.log.info("Rondyr did not store a queued submission yet", details);
  // Another attempt took the entry after this one's lease ended: its outcome stands.
  if (written === null) return "skipped";
  return next.state === "failed" ? "failed" : "retry";
}

/**
 * Send the entries that are due, oldest first, at most `batchSize` and for at
 * most `runBudgetMs`, then forget old webhook deliveries and origins. An entry that throws
 * stays claimed until its lease ends, then the next run finds it due.
 */
export async function sendDue(
  ctx: DeliveryHost,
  options: ResolvedOptions,
  token: string | null,
  clock: Clock = Date.now,
): Promise<void> {
  const store = new Store(ctx);
  const started = clock();
  if (token !== null && ctx.http !== undefined) {
    const due = await store.queueEntries("pending", batchSize, started, null);
    for (const { id } of due) {
      if (clock() - started >= runBudgetMs) break;
      try {
        await attempt(ctx, options, token, id, clock);
      } catch (error) {
        ctx.log.error("A queued submission could not be sent", {
          submissionId: id,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }
  await store.forgetDeliveries(started - deliveryMemoryMs);
  await store.forgetOrigins(started - originMemoryMs);
}

/**
 * The Retry action and a newly linked form: make failed or unlinked entries
 * due now. Returns how many entries changed.
 */
export async function requeue(
  ctx: StorageHost,
  state: "failed" | "unlinked",
  formSlug: string | null,
  clock: Clock = Date.now,
): Promise<number> {
  const store = new Store(ctx);
  let moved = 0;
  // Each pass moves the entries it read out of the state, so the next pass reads new ones.
  for (let pass = 0; pass < 20; pass += 1) {
    const entries = await store.queueEntries(state, 100, null, formSlug);
    if (entries.length === 0) break;
    for (const { id } of entries) {
      const current = await store.versionedQueueEntry(id);
      if (current === null || current.value.state !== state) continue;
      const revision = await store.replaceQueueEntry(
        id,
        current.revision,
        retried(current.value, clock()),
      );
      if (revision !== null) moved += 1;
    }
  }
  return moved;
}
