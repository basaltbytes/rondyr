import { describe, expect, it } from "vitest";

import { afterAttempt, newEntry, retried, unlinked } from "./queue.ts";
import { retryWindowMs } from "./retry.ts";

const start = Date.UTC(2026, 10, 21, 12);
const entry = newEntry("contact", { message: "Hello" }, start);

describe("queue transitions", () => {
  it("starts pending, with the cron as a fallback a minute later", () => {
    expect(entry).toMatchObject({ state: "pending", attempts: 0, nextAttemptAt: start + 60_000 });
  });

  it("removes the entry once Rondyr answers 202", () => {
    expect(afterAttempt(entry, { kind: "accepted" }, start)).toBeNull();
  });

  it("schedules a retryable failure", () => {
    const first = afterAttempt(entry, { kind: "retry", status: 503 }, start);
    expect(first).toMatchObject({ state: "pending", attempts: 1, lastStatus: 503 });
    expect(first?.nextAttemptAt).toBe(start + 60_000);
    const second = first && afterAttempt(first, { kind: "retry", status: null }, start + 60_000);
    expect(second).toMatchObject({ attempts: 2, lastStatus: null, nextAttemptAt: start + 360_000 });
  });

  it("fails a retryable entry after seven days in the queue", () => {
    const late = afterAttempt(entry, { kind: "retry", status: 503 }, start + retryWindowMs);
    expect(late).toMatchObject({ state: "failed", lastStatus: 503 });
  });

  it("fails at once on a refusal, and keeps the status", () => {
    expect(afterAttempt(entry, { kind: "refused", status: 404 }, start)).toMatchObject({
      state: "failed",
      attempts: 1,
      lastStatus: 404,
    });
  });

  it("waits unlinked, then a link or Retry makes it due now with a new window", () => {
    const waiting = unlinked(entry);
    expect(waiting.state).toBe("unlinked");
    const later = start + 3_600_000;
    expect(retried(waiting, later)).toMatchObject({
      state: "pending",
      attempts: 0,
      enqueuedAt: later,
      nextAttemptAt: later,
    });
    expect(retried(entry, later)).toBe(entry);
  });
});
