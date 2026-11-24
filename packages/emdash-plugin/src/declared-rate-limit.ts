import { z } from "astro/zod";
import type { PluginContext } from "emdash";

/**
 * Counter keys are `declared:rl:<window>:<form slug>:<client hash>`, where
 * `<window>` is the number of the fixed 60-second window since the epoch. A
 * request only ever writes the key of the current window, so a key of an
 * earlier window is never written again and the cron deletes it without a
 * conditional write.
 */
const rateLimitPrefix = "declared:rl:";
/** The site's random HMAC key for client hashes, created on first use. */
const hashKeyName = "state:declared-rate-limit-key";
const casAttempts = 5;
const purgeBatch = 50;
const hexGroup = /^[0-9a-fA-F]{1,4}$/u;
const decimalOctet = /^(?:0|[1-9]\d{0,2})$/u;
const encoder = new TextEncoder();

/** Maximum submissions allowed per (form, client) in one fixed window. */
export const declaredRateLimitMax = 5;

/** Fixed window duration for declared-mode per-client rate limiting (60 seconds). */
export const declaredRateLimitWindowMs = 60_000;

const RateLimitCount = z.object({ count: z.number().int().min(1) });
type RateLimitCount = z.infer<typeof RateLimitCount>;

const HashKey = z.string().regex(/^[0-9a-f]{64}$/u);

export interface RateLimitHost {
  readonly kv: Pick<PluginContext["kv"], "getVersioned" | "compareAndSet">;
  readonly log: Pick<PluginContext["log"], "warn">;
}

export interface RateLimitPurgeHost {
  readonly kv: Pick<PluginContext["kv"], "list" | "delete">;
  readonly log: Pick<PluginContext["log"], "warn">;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const windowOf = (now: number) => Math.floor(now / declaredRateLimitWindowMs);

function parseIpv4Pair(part: string): [number, number] | null {
  const octets = part.split(".");
  if (octets.length !== 4) return null;
  const nums: number[] = [];
  for (const octet of octets) {
    if (!decimalOctet.test(octet)) return null;
    const value = Number(octet);
    if (value > 255) return null;
    nums.push(value);
  }
  const [a, b, c, d] = nums;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return [(a << 8) | b, (c << 8) | d];
}

function parseGroupList(parts: readonly string[]): number[] | null {
  const groups: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) return null;
    if (part.includes(".")) {
      // Embedded IPv4 may appear only at the end of an IPv6 address.
      if (index !== parts.length - 1) return null;
      const pair = parseIpv4Pair(part);
      if (pair === null) return null;
      groups.push(pair[0], pair[1]);
      continue;
    }
    if (!hexGroup.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function parseIpv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const groups = parseGroupList(address.split(":"));
    return groups !== null && groups.length === 8 ? groups : null;
  }
  const [leftText, rightText] = halves;
  if (leftText === undefined || rightText === undefined) return null;
  const left = leftText === "" ? [] : parseGroupList(leftText.split(":"));
  const right = rightText === "" ? [] : parseGroupList(rightText.split(":"));
  if (left === null || right === null) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

/**
 * Normalize a visitor IP before hashing: IPv6 addresses collapse to their
 * canonical `/64` prefix, while IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`)
 * collapse to their IPv4 form so they share a bucket with plain IPv4.
 */
export function normalizeClientIp(raw: string): string {
  const trimmed = raw.trim();
  const zoneIndex = trimmed.indexOf("%");
  const address = zoneIndex === -1 ? trimmed : trimmed.slice(0, zoneIndex);
  if (!address.includes(":")) return address.toLowerCase();
  const groups = parseIpv6Groups(address);
  if (groups === null) return address.toLowerCase();
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (
    g0 === undefined ||
    g1 === undefined ||
    g2 === undefined ||
    g3 === undefined ||
    g4 === undefined ||
    g5 === undefined ||
    g6 === undefined ||
    g7 === undefined
  ) {
    return address.toLowerCase();
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }
  const prefix = [g0, g1, g2, g3].map((group) => group.toString(16).padStart(4, "0")).join(":");
  return `${prefix}::/64`;
}

/**
 * The site's HMAC key for client hashes: 32 random bytes kept in the plugin's
 * KV, created by the first request that needs it. Concurrent first requests
 * agree on one value through the conditional write.
 */
async function siteHashKey(kv: RateLimitHost["kv"]): Promise<CryptoKey> {
  for (let attempt = 0; attempt < casAttempts; attempt += 1) {
    const stored = await kv.getVersioned<unknown>(hashKeyName);
    const parsed = HashKey.safeParse(stored?.value);
    const hex = parsed.success ? parsed.data : toHex(crypto.getRandomValues(new Uint8Array(32)));
    if (!parsed.success) {
      const written = await kv.compareAndSet(hashKeyName, stored?.revision ?? null, hex);
      if (!written.applied) continue;
    }
    const bytes = Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
    return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
  }
  throw new Error("The rate limit key kept changing");
}

/**
 * HMAC-SHA-256 of the normalized client IP under the site's own key. A plain
 * hash of an IPv4 address is reversed by trying every address; without the
 * key, the stored hash says nothing about the address.
 */
async function hashClientIp(key: CryptoKey, raw: string): Promise<string> {
  const normalized = normalizeClientIp(raw);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(normalized))));
}

/**
 * Enforce a fixed-window per-(form, client) rate limit in KV using CAS.
 * Skips when `visitorIp` is absent or empty, and fails open if KV is unavailable.
 */
export async function checkDeclaredRateLimit(
  ctx: RateLimitHost,
  formSlug: string,
  visitorIp: string | null,
  now = Date.now(),
): Promise<boolean> {
  if (visitorIp === null || visitorIp.trim() === "") return true;
  try {
    const clientHash = await hashClientIp(await siteHashKey(ctx.kv), visitorIp);
    const key = `${rateLimitPrefix}${windowOf(now)}:${formSlug}:${clientHash}`;
    for (let attempt = 0; attempt < casAttempts; attempt += 1) {
      const current = await ctx.kv.getVersioned<unknown>(key);
      const parsed = RateLimitCount.safeParse(current?.value);
      const count = parsed.success ? parsed.data.count : 0;
      if (count >= declaredRateLimitMax) return false;
      const next: RateLimitCount = { count: count + 1 };
      const result = await ctx.kv.compareAndSet(key, current?.revision ?? null, next);
      if (result.applied) return true;
    }
    ctx.log.warn("Declared form rate limit counter kept changing", { form: formSlug });
    return true;
  } catch (error) {
    // Fail open and log only the error's name, never the visitor IP or submission fields.
    ctx.log.warn("Declared form rate limit check failed", {
      form: formSlug,
      error: error instanceof Error ? error.name : "unknown",
    });
    return true;
  }
}

/**
 * Delete the counters of every window before the current one. The plugin's
 * cron runs this every minute, so a counter outlives its window by about a
 * minute. A key whose window is not a number is not one this version writes,
 * and goes too. A failure is logged by name and waits for the next run.
 */
export async function purgeDeclaredRateLimits(
  ctx: RateLimitPurgeHost,
  now = Date.now(),
): Promise<number> {
  const current = windowOf(now);
  try {
    const expired = (await ctx.kv.list(rateLimitPrefix))
      .map(({ key }) => key)
      .filter((key) => {
        const window = key.slice(rateLimitPrefix.length).split(":", 1)[0] ?? "";
        return !/^\d+$/u.test(window) || Number(window) < current;
      });
    for (let index = 0; index < expired.length; index += purgeBatch) {
      await Promise.all(expired.slice(index, index + purgeBatch).map((key) => ctx.kv.delete(key)));
    }
    return expired.length;
  } catch (error) {
    ctx.log.warn("Declared form rate limit counters could not be purged", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return 0;
  }
}
