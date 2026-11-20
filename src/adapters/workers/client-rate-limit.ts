import { Effect, Layer, Schema } from "effect";

import { ClientRateLimit } from "../../ports/client-rate-limit.ts";

class RateLimitUnavailable extends Schema.TaggedError<
  RateLimitUnavailable,
  { readonly brand: unique symbol }
>()("RateLimitUnavailable", {}) {}

const hextet = /^[0-9a-f]{1,4}$/u;

/** The eight 16-bit groups of an IPv6 address, or null for anything else. */
function ipv6Groups(address: string): ReadonlyArray<number> | null {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const parts = halves.map((half) => (half === "" ? [] : half.split(":")));
  const [head = [], tail = []] = parts;
  const groups: Array<number> = [];
  for (const part of [...head, ...tail]) {
    if (!hextet.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  if (halves.length === 1) return groups.length === 8 ? groups : null;
  if (groups.length > 7) return null;
  const zeros = Array.from({ length: 8 - groups.length }, () => 0);
  return [...groups.slice(0, head.length), ...zeros, ...groups.slice(head.length)];
}

/**
 * The client that a rate limit counts. An IPv4 address is one client. An IPv6
 * client usually has a whole /64 network to itself, and can change its address
 * inside it at will, so the /64 prefix is the client. Cloudflare sends IPv6
 * addresses with letters, and a dotted IPv4 suffix is not expected; an address
 * that does not parse counts as itself.
 */
export function rateLimitedClient(address: string) {
  if (!address.includes(":")) return address;
  const groups = ipv6Groups(address);
  if (groups === null) return address;
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/**
 * The client limit through the Workers Rate Limiting binding `CLIENT_RATE_LIMIT`.
 * Cloudflare keeps the counters; Rondyr stores no address. The counter is per
 * Cloudflare location and approximate, as Cloudflare documents.
 */
export const clientRateLimitLive = Layer.succeed(ClientRateLimit, {
  admit: Effect.fn("ClientRateLimit.admit")(function* (publicId: string, clientAddress: string) {
    const { env } = yield* Effect.promise(() => import("cloudflare:workers"));
    const key = `${publicId}:${rateLimitedClient(clientAddress)}`;
    return yield* Effect.tryPromise({
      try: () => env.CLIENT_RATE_LIMIT.limit({ key }),
      catch: () => RateLimitUnavailable.make(),
    }).pipe(
      Effect.map(({ success }) => success),
      Effect.tapError(() =>
        Effect.logWarning("Client rate limit unavailable; submission admitted"),
      ),
      Effect.orElseSucceed(() => true),
    );
  }),
});
