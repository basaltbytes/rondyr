import type { PluginContext } from "emdash";

import { afterAttempt, retried, unlinked, type QueueEntry } from "./core/queue.ts";
import { sendOutcome } from "./core/retry.ts";
import { RondyrClient } from "./core/rondyr-client.ts";
import type { ResolvedOptions } from "./options.ts";
import { Store, type StorageHost } from "./store.ts";

/** How many due entries one cron tick sends, so a long outage drains over several minutes. */
const batchSize = 25;

/** Rondyr retries a webhook for about nine hours; delivery IDs are kept for 30 days. */
const deliveryMemoryMs = 30 * 24 * 3_600_000;

/** What sending needs from a plugin context: storage, a logger and `ctx.http`. */
export interface DeliveryHost extends StorageHost {
  readonly http?: Pick<NonNullable<PluginContext["http"]>, "fetch">;
}

/**
 * Send one queue entry to Rondyr and record what happened. The entry is
 * deleted only after a `202`. Without a token (`RONDYR_API_TOKEN`), it stays
 * pending. An entry of a form without a Rondyr form becomes `unlinked`.
 */
export async function attempt(
  ctx: DeliveryHost,
  options: ResolvedOptions,
  token: string | null,
  id: string,
  entry: QueueEntry,
): Promise<void> {
  if (token === null || ctx.http === undefined) return;
  const store = new Store(ctx);
  const link = await store.link(entry.formSlug);
  if (link?.rondyrFormId === null || link === null) {
    await store.putQueueEntry(id, unlinked(entry));
    return;
  }
  const http = ctx.http;
  const client = new RondyrClient((url, init) => http.fetch(url, init), options.url, token);
  const status = await client.submit(link.rondyrFormId, entry.fields, id);
  const next = afterAttempt(entry, sendOutcome(status), Date.now());
  if (next === null) {
    await store.deleteQueueEntry(id);
    return;
  }
  await store.putQueueEntry(id, next);
  // The submission ID and the status only: the fields stay in storage.
  const log = next.state === "failed" ? ctx.log.warn : ctx.log.info;
  log.call(ctx.log, "Rondyr did not store a queued submission", {
    submissionId: id,
    status,
    state: next.state,
  });
}

/** Send the entries that are due, oldest first, and forget old webhook deliveries. */
export async function sendDue(
  ctx: DeliveryHost,
  options: ResolvedOptions,
  token: string | null,
): Promise<void> {
  const store = new Store(ctx);
  const now = Date.now();
  const due = await store.queueEntries("pending", batchSize, now, null);
  for (const { id, entry } of due) await attempt(ctx, options, token, id, entry);
  await store.forgetDeliveries(now - deliveryMemoryMs);
}

/**
 * The Retry action and a newly linked form: make failed or unlinked entries
 * due now. Returns how many entries changed.
 */
export async function requeue(
  ctx: StorageHost,
  state: "failed" | "unlinked",
  formSlug: string | null,
): Promise<number> {
  const store = new Store(ctx);
  const now = Date.now();
  let moved = 0;
  // Each pass moves the entries it read out of the state, so the next pass reads new ones.
  for (let pass = 0; pass < 20; pass += 1) {
    const entries = await store.queueEntries(state, 100, null, formSlug);
    if (entries.length === 0) break;
    for (const { id, entry } of entries) await store.putQueueEntry(id, retried(entry, now));
    moved += entries.length;
  }
  return moved;
}
