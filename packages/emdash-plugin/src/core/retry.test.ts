import { describe, expect, it } from "vitest";

import { retryDelayMs, sendOutcome } from "./retry.ts";

const minute = 60_000;

describe("retryDelayMs", () => {
  it("waits 1 min, 5 min, 30 min, 2 h, 6 h, then every 6 h", () => {
    expect([1, 2, 3, 4, 5, 6, 40].map(retryDelayMs)).toEqual([
      minute,
      5 * minute,
      30 * minute,
      120 * minute,
      360 * minute,
      360 * minute,
      360 * minute,
    ]);
  });
});

describe("sendOutcome", () => {
  it("accepts only 202", () => {
    expect(sendOutcome(202)).toEqual({ kind: "accepted" });
    expect(sendOutcome(200)).toEqual({ kind: "refused", status: 200 });
  });

  it("retries a network error, 429 and 5xx", () => {
    for (const status of [null, 429, 500, 502, 503]) {
      expect(sendOutcome(status)).toEqual({ kind: "retry", status });
    }
  });

  it("gives up at once on 3xx, 400, 401, 403 and 404", () => {
    for (const status of [301, 302, 307, 400, 401, 403, 404]) {
      expect(sendOutcome(status)).toEqual({ kind: "refused", status });
    }
  });
});
