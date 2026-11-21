import { describe, expect, it } from "vitest";

import { newEntry, QueueEntry } from "./core/queue.ts";
import { attempt, requeue, sendDue } from "./delivery.ts";
import { Store } from "./store.ts";
import { memoryHost } from "./testing/memory-storage.ts";

const options = { url: "https://rondyr.example.com" };
const id = "5a0c1d2e-3f40-4152-8a6b-7c8d9e0f1a01";

/** A Rondyr that answers each call with the next status, or a network error for null. */
function rondyr(statuses: readonly (number | null)[]) {
  const calls: { url: string; key: string | null }[] = [];
  const http = {
    fetch: async (url: string, init?: RequestInit) => {
      const index = calls.length;
      const status = index < statuses.length ? (statuses[index] ?? null) : 202;
      calls.push({ url, key: new Headers(init?.headers).get("idempotency-key") });
      if (status === null) throw new Error("Network error");
      return new Response(null, { status });
    },
  };
  return { http, calls };
}

async function queued(state: { linked: boolean }) {
  const { host, collections } = memoryHost();
  const store = new Store(host);
  if (state.linked) await store.putLink("contact", { rondyrFormId: "public-id", recipients: [] });
  const entry = newEntry("contact", { message: "Hello" }, Date.now());
  await store.putQueueEntry(id, entry);
  return { host, store, collections, entry };
}

describe("attempt", () => {
  it("deletes the entry only after a 202, with the submission ID as idempotency key", async () => {
    const { host, store, entry } = await queued({ linked: true });
    const { http, calls } = rondyr([null, 202]);
    await attempt({ ...host, http }, options, "rdr_token", id, entry);
    const pending = await store.queueEntry(id);
    expect(pending).toMatchObject({ state: "pending", attempts: 1, lastStatus: null });
    await attempt({ ...host, http }, options, "rdr_token", id, QueueEntry.parse(pending));
    expect(await store.queueEntry(id)).toBeNull();
    expect(calls).toEqual([
      { url: "https://rondyr.example.com/f/public-id", key: id },
      { url: "https://rondyr.example.com/f/public-id", key: id },
    ]);
  });

  it("fails the entry at once on a refusal", async () => {
    const { host, store, entry } = await queued({ linked: true });
    await attempt({ ...host, http: rondyr([404]).http }, options, "rdr_token", id, entry);
    expect(await store.queueEntry(id)).toMatchObject({ state: "failed", lastStatus: 404 });
  });

  it("keeps the entry pending without a token, and unlinked without a Rondyr form", async () => {
    const linked = await queued({ linked: true });
    const { http, calls } = rondyr([]);
    await attempt({ ...linked.host, http }, options, null, id, linked.entry);
    expect(await linked.store.queueEntry(id)).toEqual(linked.entry);
    const unlinked = await queued({ linked: false });
    await attempt({ ...unlinked.host, http }, options, "rdr_token", id, unlinked.entry);
    expect(await unlinked.store.queueEntry(id)).toMatchObject({ state: "unlinked" });
    expect(calls).toEqual([]);
  });
});

describe("sendDue and requeue", () => {
  it("sends only due entries, and Retry makes failed ones due again", async () => {
    const { host, store, entry } = await queued({ linked: true });
    const { http, calls } = rondyr([503, 404, 202]);
    // Not due yet: the first attempt is the one after the response.
    await sendDue({ ...host, http }, options, "rdr_token");
    expect(calls).toHaveLength(0);
    await store.putQueueEntry(id, { ...entry, nextAttemptAt: 0 });
    await sendDue({ ...host, http }, options, "rdr_token");
    expect(await store.queueEntry(id)).toMatchObject({ state: "pending", lastStatus: 503 });
    const due = QueueEntry.parse(await store.queueEntry(id));
    await store.putQueueEntry(id, { ...due, nextAttemptAt: 0 });
    await sendDue({ ...host, http }, options, "rdr_token");
    expect(await store.queueEntry(id)).toMatchObject({ state: "failed", lastStatus: 404 });

    expect(await requeue(host, "failed", null)).toBe(1);
    await sendDue({ ...host, http }, options, "rdr_token");
    expect(await store.queueEntry(id)).toBeNull();
    expect(calls).toHaveLength(3);
  });
});
