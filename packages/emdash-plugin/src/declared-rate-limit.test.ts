import type { PluginContext } from "emdash";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { describe, expect, it } from "vitest";

import { DeclaredForm } from "./core/declared-forms.ts";
import {
  checkDeclaredRateLimit,
  declaredRateLimitMax,
  declaredRateLimitWindowMs,
  normalizeClientIp,
  purgeDeclaredRateLimits,
} from "./declared-rate-limit.ts";
import { DeclaredPost, receiveDeclaredPost } from "./declared-submission.ts";
import { enqueue } from "./enqueue.ts";
import { handleSubmission } from "./site-route.ts";
import { MemoryCollection, memoryHost } from "./testing/memory-storage.ts";

type KvAccess = PluginContext["kv"];

class MemoryKv implements KvAccess {
  readonly rows = new MemoryCollection();

  async get<T>(key: string): Promise<T | null> {
    // SAFETY: unit test reads back the value it wrote under this key.
    return (await this.rows.get(key)) as T | null;
  }

  async getVersioned<T>(key: string) {
    const row = await this.rows.getVersioned(key);
    // SAFETY: unit test reads back the value it wrote under this key.
    return row === null ? null : { value: row.value as T, revision: row.revision };
  }

  compareAndSet: KvAccess["compareAndSet"] = (key, revision, value) =>
    this.rows.compareAndSet(key, revision, value);

  compareAndDelete: KvAccess["compareAndDelete"] = (key, revision) =>
    this.rows.compareAndDelete(key, revision);

  set: KvAccess["set"] = (key, value) => this.rows.put(key, value);

  delete: KvAccess["delete"] = (key) => this.rows.delete(key);

  list: KvAccess["list"] = async (prefix = "") =>
    [...this.rows.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, { data }]) => ({ key, value: data }));
}

describe("normalizeClientIp", () => {
  it("normalizes IPv6 addresses to their canonical /64 prefix", () => {
    expect(normalizeClientIp("2001:db8:85a3:1::1")).toBe("2001:0db8:85a3:0001::/64");
    expect(normalizeClientIp("2001:0db8:85a3:0001:abcd:ef01:2345:6789")).toBe(
      "2001:0db8:85a3:0001::/64",
    );
    expect(normalizeClientIp("2001:db8:85a3:2::1")).toBe("2001:0db8:85a3:0002::/64");
    expect(normalizeClientIp("::1")).toBe("0000:0000:0000:0000::/64");
    expect(normalizeClientIp("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
  });

  it("keeps IPv4 addresses and collapses IPv4-mapped IPv6 to IPv4", () => {
    expect(normalizeClientIp("203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeClientIp("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizeClientIp("::ffff:cb00:7107")).toBe("203.0.113.7");
  });
});

describe("checkDeclaredRateLimit", () => {
  const start = Date.UTC(2026, 10, 24, 12);

  it("allows 5 requests in a window, blocks the 6th, and counts again in the next window", async () => {
    const kv = new MemoryKv();
    const { host } = memoryHost();
    const ctx = { kv, log: host.log };
    const ip = "203.0.113.42";

    for (let index = 0; index < declaredRateLimitMax; index += 1) {
      expect(await checkDeclaredRateLimit(ctx, "contact", ip, start + index * 1_000)).toBe(true);
    }
    expect(await checkDeclaredRateLimit(ctx, "contact", ip, start + 10_000)).toBe(false);

    // A separate form keeps its own bucket.
    expect(await checkDeclaredRateLimit(ctx, "newsletter", ip, start + 10_000)).toBe(true);

    expect(
      await checkDeclaredRateLimit(ctx, "contact", ip, start + declaredRateLimitWindowMs),
    ).toBe(true);
  });

  it("stores neither the IP nor its plain SHA-256 in KV", async () => {
    const kv = new MemoryKv();
    const { host } = memoryHost();
    const ip = "203.0.113.42";
    const plainSha256 = "17af1cf3d1b5332c53349fc789abdc853bbeea7ed33eff727ff794ab741ccac9";

    await checkDeclaredRateLimit({ kv, log: host.log }, "contact", ip, start);

    const serialized = JSON.stringify([...kv.rows.rows.entries()]);
    expect(serialized).not.toContain(ip);
    expect(serialized).not.toContain(plainSha256);
  });

  it("hashes the same visitor differently on two sites", async () => {
    const { host } = memoryHost();
    const first = new MemoryKv();
    const second = new MemoryKv();

    await checkDeclaredRateLimit({ kv: first, log: host.log }, "contact", "203.0.113.42", start);
    await checkDeclaredRateLimit({ kv: second, log: host.log }, "contact", "203.0.113.42", start);

    const counterKeys = (kv: MemoryKv) =>
      [...kv.rows.rows.keys()].filter((key) => key.startsWith("declared:rl:"));
    expect(counterKeys(first)).toHaveLength(1);
    expect(counterKeys(second)).toHaveLength(1);
    expect(counterKeys(first)).not.toEqual(counterKeys(second));
  });

  it("keeps the site's hash key across requests, so a visitor keeps one counter", async () => {
    const kv = new MemoryKv();
    const { host } = memoryHost();
    const ctx = { kv, log: host.log };

    await checkDeclaredRateLimit(ctx, "contact", "203.0.113.42", start);
    const keyAfterFirst = await kv.get("state:declared-rate-limit-key");
    await checkDeclaredRateLimit(ctx, "contact", "203.0.113.42", start + 1_000);

    expect(await kv.get("state:declared-rate-limit-key")).toBe(keyAfterFirst);
    expect([...kv.rows.rows.values()]).toContainEqual(
      expect.objectContaining({ data: { count: 2 } }),
    );
  });

  it("groups IPv6 clients by their /64 prefix", async () => {
    const kv = new MemoryKv();
    const { host } = memoryHost();
    const ctx = { kv, log: host.log };

    for (let index = 1; index <= declaredRateLimitMax; index += 1) {
      const address = `2001:db8:abcd:0001::${index.toString(16)}`;
      expect(await checkDeclaredRateLimit(ctx, "contact", address, start)).toBe(true);
    }
    expect(
      await checkDeclaredRateLimit(ctx, "contact", "2001:0db8:abcd:1:ffff::9999", start + 5_000),
    ).toBe(false);
    // Different /64 prefix gets its own bucket.
    expect(
      await checkDeclaredRateLimit(ctx, "contact", "2001:db8:abcd:0002::1", start + 5_000),
    ).toBe(true);
    expect([...kv.rows.rows.keys()].filter((key) => key.startsWith("declared:rl:"))).toHaveLength(
      2,
    );
  });

  it("skips rate limiting when cf-connecting-ip is absent or blank", async () => {
    const kv = new MemoryKv();
    const { host } = memoryHost();
    const ctx = { kv, log: host.log };

    for (let index = 0; index < declaredRateLimitMax + 3; index += 1) {
      expect(await checkDeclaredRateLimit(ctx, "contact", null, start)).toBe(true);
      expect(await checkDeclaredRateLimit(ctx, "contact", "   ", start)).toBe(true);
    }
    expect(kv.rows.rows.size).toBe(0);
  });

  it("fails open when KV throws and logs only the error name, never the IP", async () => {
    const { host, lines } = memoryHost();
    const ip = "198.51.100.77";
    const brokenKv = {
      getVersioned: async (): Promise<never> => {
        throw new RangeError(`KV unavailable for ${ip}`);
      },
      compareAndSet: async () => {
        throw new RangeError(`KV unavailable for ${ip}`);
      },
    };
    const allowed = await checkDeclaredRateLimit(
      { kv: brokenKv, log: host.log },
      "contact",
      ip,
      start,
    );
    expect(allowed).toBe(true);
    expect(lines).toEqual([
      {
        level: "warn",
        message: "Declared form rate limit check failed",
        data: { form: "contact", error: "RangeError" },
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain(ip);
  });
});

describe("purgeDeclaredRateLimits", () => {
  const start = Date.UTC(2026, 10, 24, 12);

  it("deletes the counters of past windows and keeps the current ones and the hash key", async () => {
    const kv = new MemoryKv();
    const { host } = memoryHost();
    const ctx = { kv, log: host.log };
    await checkDeclaredRateLimit(ctx, "contact", "203.0.113.42", start);
    await checkDeclaredRateLimit(ctx, "contact", "198.51.100.7", start + 30_000);
    await checkDeclaredRateLimit(ctx, "contact", "203.0.113.42", start + declaredRateLimitWindowMs);

    const purged = await purgeDeclaredRateLimits(ctx, start + declaredRateLimitWindowMs + 1_000);

    expect(purged).toBe(2);
    expect([...kv.rows.rows.keys()]).toEqual([
      "state:declared-rate-limit-key",
      expect.stringMatching(/^declared:rl:\d+:contact:[0-9a-f]{64}$/u),
    ]);
  });

  it("deletes a counter key that does not carry a window number", async () => {
    const kv = new MemoryKv();
    const { host } = memoryHost();
    await kv.set("declared:rl:contact:0123", { windowStart: start, count: 1 });

    expect(await purgeDeclaredRateLimits({ kv, log: host.log }, start)).toBe(1);
    expect(kv.rows.rows.size).toBe(0);
  });

  it("logs only the error name when KV fails", async () => {
    const { host, lines } = memoryHost();
    const brokenKv = {
      list: async (): Promise<never> => {
        throw new RangeError("KV unavailable");
      },
      delete: async (): Promise<never> => {
        throw new RangeError("KV unavailable");
      },
    };

    expect(await purgeDeclaredRateLimits({ kv: brokenKv, log: host.log }, start)).toBe(0);
    expect(lines).toEqual([
      {
        level: "warn",
        message: "Declared form rate limit counters could not be purged",
        data: { error: "RangeError" },
      },
    ]);
  });
});

describe("declared/submit rate limiting through handleSubmission", () => {
  it("returns 429 with Retry-After on the 6th JSON submission and redirects form posts to error", async () => {
    const origin = "https://site.example.com";
    const now = Date.UTC(2026, 10, 24, 12);
    const kv = new MemoryKv();
    const { host } = memoryHost();
    const contact = DeclaredForm.parse({
      slug: "contact",
      name: "Contact",
      spamProtection: "honeypot",
      fields: [{ name: "message", type: "textarea", required: true, labels: { en: "Message" } }],
    });

    const handlePublicPluginApiRoute: PublicPluginApiRouteHandler = async (
      _plugin,
      _method,
      _path,
      request,
    ) => {
      const post = DeclaredPost.parse(await request.json());
      const answer = await receiveDeclaredPost(
        post.formId === contact.slug ? contact : undefined,
        post,
        request.headers.get("cf-connecting-ip"),
        async (entry) => {
          await enqueue(host, entry, now);
        },
        { host: { kv, log: host.log }, now },
      );
      return { success: true, data: answer };
    };
    const locals = {
      emdash: {
        handlePublicPluginApiRoute,
        getPublicPluginRouteMeta: () => ({ public: true }),
      },
    };
    const url = new URL("/api/form", origin);
    const visitorIp = "203.0.113.88";
    const postJson = () =>
      handleSubmission(
        {
          request: new Request(url, {
            method: "POST",
            headers: {
              origin,
              "content-type": "application/json",
              "cf-connecting-ip": visitorIp,
            },
            body: JSON.stringify({ formId: "contact", data: { message: "Hello" } }),
          }),
          url,
          locals,
        },
        null,
      );

    for (let index = 0; index < declaredRateLimitMax; index += 1) {
      const response = await postJson();
      expect(response.status).toBe(200);
    }

    const limitedJson = await postJson();
    expect(limitedJson.status).toBe(429);
    expect(limitedJson.headers.get("retry-after")).toBe("60");
    expect(limitedJson.headers.get("cache-control")).toBe("private, no-store");
    expect(await limitedJson.json()).toEqual({
      success: false,
      error: {
        code: "RATE_LIMITED",
        message: "Too many submissions. Please try again later.",
      },
    });

    const limitedForm = await handleSubmission(
      {
        request: new Request(url, {
          method: "POST",
          headers: { origin, "cf-connecting-ip": visitorIp },
          body: new URLSearchParams({
            formId: "contact",
            message: "Hello",
            _return: "/contact",
            _block: "contact",
          }),
        }),
        url,
        locals,
      },
      null,
    );
    expect(limitedForm.status).toBe(303);
    expect(limitedForm.headers.get("location")).toBe(
      "/contact?form=contact&status=error#contact-status",
    );
    expect(limitedForm.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.stringify([...kv.rows.rows.entries()])).not.toContain(visitorIp);
  });
});
