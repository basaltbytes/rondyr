import { describe, expect, it } from "vitest";

import { newEntry, type QueueEntry } from "./core/queue.ts";
import { attemptLeaseMs } from "./core/retry.ts";
import { attempt, originMemoryMs, requeue, sendDue } from "./delivery.ts";
import { Store } from "./store.ts";
import { memoryHost } from "./testing/memory-storage.ts";

const options = { url: "https://rondyr.example.com" };
const token = `rdr_${"T".repeat(43)}`;
const id = "5a0c1d2e-3f40-4152-8a6b-7c8d9e0f1a01";
const start = Date.UTC(2026, 10, 21, 12);
const message = "Hello, a private message";

/** A clock the test moves by hand. */
function clockAt(time: number) {
  const clock = { now: time, read: () => clock.now };
  return clock;
}

/** The ID Rondyr gives the submission sent with an idempotency key: the same on every replay. */
function rondyrId(key: string | null) {
  return `rondyr-${key}`;
}

/** Rondyr's answer to a server intake that it stored. */
function stored(key: string | null) {
  return Response.json({ "submission-id": rondyrId(key), status: "received" }, { status: 202 });
}

/** A Rondyr that answers each call with the next status, or a network error for null. */
function rondyr(statuses: readonly (number | null)[]) {
  const calls: { url: string; key: string | null }[] = [];
  const http = {
    fetch: async (url: string, init?: RequestInit) => {
      const index = calls.length;
      const status = index < statuses.length ? (statuses[index] ?? null) : 202;
      const key = new Headers(init?.headers).get("idempotency-key");
      calls.push({ url, key });
      if (status === null) throw new TypeError("Network connection lost");
      return status === 202 ? stored(key) : new Response(null, { status });
    },
  };
  return { http, calls };
}

async function queued(linked: boolean, entries: readonly string[] = [id]) {
  const { host, collections, lines } = memoryHost();
  const store = new Store(host);
  if (linked) await store.putLink("contact", { rondyrFormId: "public-id", recipients: [] });
  for (const key of entries) {
    await store.createQueueEntry(key, newEntry("contact", { message }, start));
  }
  return { host, store, collections, lines };
}

function expectNoContent(lines: readonly unknown[]) {
  const logged = JSON.stringify(lines);
  expect(logged).not.toContain(message);
  expect(logged).not.toContain(token);
}

describe("attempt", () => {
  it("deletes the entry only after a 202, with the submission ID as idempotency key", async () => {
    const { host, store, lines } = await queued(true);
    const { http, calls } = rondyr([null, 202]);
    const clock = clockAt(start);
    expect(await attempt({ ...host, http }, options, token, id, clock.read)).toBe("retry");
    expect(await store.queueEntry(id)).toMatchObject({
      state: "pending",
      attempts: 1,
      lastStatus: null,
      nextAttemptAt: start + 60_000,
    });
    // Not due yet: nothing is sent.
    expect(await attempt({ ...host, http }, options, token, id, clock.read)).toBe("skipped");
    clock.now = start + 60_000;
    expect(await attempt({ ...host, http }, options, token, id, clock.read)).toBe("sent");
    expect(await store.queueEntry(id)).toBeNull();
    // The submission ID that Rondyr returned leads back to the EmDash form, for the webhook.
    expect(await store.origin(rondyrId(id))).toEqual({
      formSlug: "contact",
      recordedAt: start + 60_000,
    });
    expect(calls).toEqual([
      { url: "https://rondyr.example.com/f/public-id", key: id },
      { url: "https://rondyr.example.com/f/public-id", key: id },
    ]);
    expect(lines).toEqual([
      {
        level: "info",
        message: "Rondyr did not store a queued submission yet",
        data: { submissionId: id, status: null, reason: "network", state: "pending" },
      },
    ]);
    expectNoContent(lines);
  });

  it("still deletes the entry when a 202 has no submission ID, and logs it", async () => {
    const { host, store, collections, lines } = await queued(true);
    const http = { fetch: async () => new Response("{}", { status: 202 }) };
    expect(await attempt({ ...host, http }, options, token, id)).toBe("sent");
    expect(await store.queueEntry(id)).toBeNull();
    expect(collections.origins.rows.size).toBe(0);
    expect(lines).toEqual([
      {
        level: "warn",
        message: "Rondyr stored a queued submission without returning its ID",
        data: { submissionId: id },
      },
    ]);
  });

  it("keeps the entry when the 202's body is cut off, and the replay records the origin", async () => {
    const { host, store } = await queued(true);
    let calls = 0;
    const http = {
      fetch: async (_url: string, init?: RequestInit) => {
        calls += 1;
        if (calls > 1) return stored(new Headers(init?.headers).get("idempotency-key"));
        const body = new ReadableStream({
          pull: (controller) => controller.error(new TypeError("Network connection lost")),
        });
        return new Response(body, { status: 202 });
      },
    };
    const clock = clockAt(start);
    expect(await attempt({ ...host, http }, options, token, id, clock.read)).toBe("retry");
    expect(await store.queueEntry(id)).toMatchObject({ state: "pending", lastStatus: null });
    clock.now = start + 60_000;
    expect(await attempt({ ...host, http }, options, token, id, clock.read)).toBe("sent");
    expect(await store.origin(rondyrId(id))).toMatchObject({ formSlug: "contact" });
  });

  it("fails the entry at once on a refusal", async () => {
    const { host, store, lines } = await queued(true);
    const result = await attempt({ ...host, http: rondyr([404]).http }, options, token, id);
    expect(result).toBe("failed");
    expect(await store.queueEntry(id)).toMatchObject({ state: "failed", lastStatus: 404 });
    expect(lines.map(({ level }) => level)).toEqual(["warn"]);
    expectNoContent(lines);
  });

  it("keeps the entry pending without a token, and unlinked without a Rondyr form", async () => {
    const linked = await queued(true);
    const { http, calls } = rondyr([]);
    const before = await linked.store.queueEntry(id);
    expect(await attempt({ ...linked.host, http }, options, null, id)).toBe("skipped");
    expect(await linked.store.queueEntry(id)).toEqual(before);
    const unlinked = await queued(false);
    expect(await attempt({ ...unlinked.host, http }, options, token, id)).toBe("unlinked");
    expect(await unlinked.store.queueEntry(id)).toMatchObject({ state: "unlinked" });
    expect(calls).toEqual([]);
  });

  it("sends an entry once when two attempts start together", async () => {
    const { host, store } = await queued(true);
    const answered = Promise.withResolvers<void>();
    let calls = 0;
    const http = {
      fetch: async () => {
        calls += 1;
        await answered.promise;
        return stored(id);
      },
    };
    const first = attempt({ ...host, http }, options, token, id);
    const second = attempt({ ...host, http }, options, token, id);
    answered.resolve();
    expect((await Promise.all([first, second])).toSorted()).toEqual(["sent", "skipped"]);
    expect(calls).toBe(1);
    expect(await store.queueEntry(id)).toBeNull();
  });

  it("never brings back an entry that a later attempt sent", async () => {
    const { host, store } = await queued(true);
    const clock = clockAt(start);
    const stalled = Promise.withResolvers<void>();
    const inFlight = Promise.withResolvers<void>();
    let calls = 0;
    const http = {
      fetch: async () => {
        calls += 1;
        // The first attempt hangs past its lease, then fails.
        if (calls === 1) {
          inFlight.resolve();
          await stalled.promise;
          return new Response(null, { status: 503 });
        }
        return stored(id);
      },
    };
    const slow = attempt({ ...host, http }, options, token, id, clock.read);
    await inFlight.promise;
    clock.now = start + attemptLeaseMs + 1;
    expect(await attempt({ ...host, http }, options, token, id, clock.read)).toBe("sent");
    stalled.resolve();
    expect(await slow).toBe("skipped");
    expect(await store.queueEntry(id)).toBeNull();
  });
});

describe("sendDue and requeue", () => {
  it("sends only due entries, and Retry makes failed ones due again", async () => {
    const { host, store, lines } = await queued(true);
    const { http, calls } = rondyr([503, 404, 202]);
    const clock = clockAt(start - 1);
    // Not due yet.
    await sendDue({ ...host, http }, options, token, clock.read);
    expect(calls).toHaveLength(0);
    clock.now = start;
    await sendDue({ ...host, http }, options, token, clock.read);
    expect(await store.queueEntry(id)).toMatchObject({ state: "pending", lastStatus: 503 });
    clock.now = start + 60_000;
    await sendDue({ ...host, http }, options, token, clock.read);
    expect(await store.queueEntry(id)).toMatchObject({ state: "failed", lastStatus: 404 });

    expect(await requeue(host, "failed", null, clock.read)).toBe(1);
    await sendDue({ ...host, http }, options, token, clock.read);
    expect(await store.queueEntry(id)).toBeNull();
    expect(calls).toHaveLength(3);
    expectNoContent(lines);
  });

  it("sends at most 25 entries per run", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `entry-${String(index).padStart(2, "0")}`);
    const { host, collections } = await queued(true, ids);
    const { http, calls } = rondyr([]);
    await sendDue({ ...host, http }, options, token, clockAt(start).read);
    expect(calls).toHaveLength(25);
    expect(collections.queue.rows.size).toBe(5);
  });

  it("starts no attempt once the run has lasted a minute", async () => {
    const ids = ["entry-a", "entry-b", "entry-c", "entry-d"];
    const { host, collections } = await queued(true, ids);
    const clock = clockAt(start);
    let calls = 0;
    const http = {
      fetch: async (_url: string, init?: RequestInit) => {
        calls += 1;
        // Each answer takes 25 seconds.
        clock.now += 25_000;
        return stored(new Headers(init?.headers).get("idempotency-key"));
      },
    };
    await sendDue({ ...host, http }, options, token, clock.read);
    expect(calls).toBe(3);
    expect(collections.queue.rows.size).toBe(1);
  });

  it("forgets the origin of a message after a year", async () => {
    const { host, store } = await queued(true, []);
    await store.putOrigin("old", { formSlug: "contact", recordedAt: start - originMemoryMs - 1 });
    await store.putOrigin("recent", { formSlug: "contact", recordedAt: start - originMemoryMs });
    await sendDue(host, options, null, clockAt(start).read);
    expect(await store.origin("old")).toBeNull();
    expect(await store.origin("recent")).toMatchObject({ formSlug: "contact" });
  });

  it("leaves a pending entry alone on Retry, and links unlinked ones", async () => {
    const { host, store } = await queued(false, ["unlinked-entry", "pending-entry"]);
    const pending: QueueEntry | null = await store.queueEntry("pending-entry");
    expect(await attempt(host, options, token, "unlinked-entry")).toBe("skipped");
    const { http } = rondyr([]);
    expect(await attempt({ ...host, http }, options, token, "unlinked-entry")).toBe("unlinked");
    expect(await requeue(host, "unlinked", "contact", clockAt(start).read)).toBe(1);
    expect(await store.queueEntry("unlinked-entry")).toMatchObject({
      state: "pending",
      nextAttemptAt: start,
    });
    expect(await store.queueEntry("pending-entry")).toEqual(pending);
  });
});
