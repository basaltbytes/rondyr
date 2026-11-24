import { Option, Result, Schema } from "effect";

/** Why a webhook URL is refused as a destination. */
export const DestinationRefusalReason = Schema.Literals([
  "invalid-url",
  "not-https",
  "credentials",
  "custom-port",
  "local-hostname",
  "reserved-address",
  "worker-origin",
]);
export type DestinationRefusalReason = typeof DestinationRefusalReason.Type;

/** An HTTPS URL that passed `parseWebhookUrl`. */
export const WebhookUrl = Schema.String.pipe(Schema.brand("WebhookUrl"));
export type WebhookUrl = typeof WebhookUrl.Type;

const maxUrlLength = 2048;

// Names that never resolve to a public address: RFC 6761, RFC 6762, RFC 8375 and
// the ICANN reservation of .internal.
const localSuffixes = ["localhost", "local", "internal", "home.arpa"];

type Range = readonly [base: number, prefix: number];

const ipv4 = (a: number, b: number, c: number, d: number) =>
  ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

// IANA IPv4 special-purpose and reserved blocks, including private (RFC 1918),
// loopback, link-local, CGNAT (RFC 6598), documentation, benchmarking and multicast.
const reservedIpv4: ReadonlyArray<Range> = [
  [ipv4(0, 0, 0, 0), 8],
  [ipv4(10, 0, 0, 0), 8],
  [ipv4(100, 64, 0, 0), 10],
  [ipv4(127, 0, 0, 0), 8],
  [ipv4(169, 254, 0, 0), 16],
  [ipv4(172, 16, 0, 0), 12],
  [ipv4(192, 0, 0, 0), 24],
  [ipv4(192, 0, 2, 0), 24],
  [ipv4(192, 88, 99, 0), 24],
  [ipv4(192, 168, 0, 0), 16],
  [ipv4(198, 18, 0, 0), 15],
  [ipv4(198, 51, 100, 0), 24],
  [ipv4(203, 0, 113, 0), 24],
  [ipv4(224, 0, 0, 0), 4],
  [ipv4(240, 0, 0, 0), 4],
];

function inRange(address: number, [base, prefix]: Range) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === base;
}

function parseIpv4(host: string) {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/u.test(part))) return undefined;
  const [a = 0, b = 0, c = 0, d = 0] = parts.map(Number);
  return ipv4(a, b, c, d);
}

const groupsOf = (text: string) => (text === "" ? [] : text.split(":"));

/** The eight 16-bit groups of a bracketed IPv6 literal, as the URL parser serializes it. */
function parseIpv6(host: string) {
  if (!host.startsWith("[") || !host.endsWith("]")) return undefined;
  const [head = "", tail, ...rest] = host.slice(1, -1).split("::");
  if (rest.length > 0) return undefined;
  const left = groupsOf(head);
  const right = tail === undefined ? [] : groupsOf(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined;
  const all = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (!all.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) return undefined;
  return all.map((group) => Number.parseInt(group, 16));
}

// Only global unicast (2000::/3) is accepted, minus the blocks of it that IANA
// reserves: IETF protocol assignments with Teredo, documentation, and 6to4, which
// embeds an IPv4 address. Everything outside 2000::/3 is refused, which covers
// loopback, unspecified, IPv4-mapped, NAT64, unique local, link-local and multicast.
function reservedIpv6(groups: ReadonlyArray<number>) {
  const [first = 0, second = 0] = groups;
  if ((first & 0xe000) !== 0x2000) return true;
  return (
    (first === 0x2001 && second < 0x0200) ||
    (first === 0x2001 && second === 0x0db8) ||
    first === 0x2002 ||
    (first === 0x3fff && second < 0x1000)
  );
}

const hostOf = (url: URL) => url.hostname.toLowerCase().replace(/\.$/u, "");

function localHostname(host: string) {
  if (!host.includes(".")) return true;
  return localSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function refusal(url: URL, workerHosts: ReadonlySet<string>): DestinationRefusalReason | undefined {
  if (url.protocol !== "https:") return "not-https";
  if (url.username !== "" || url.password !== "") return "credentials";
  if (url.port !== "") return "custom-port";
  const host = hostOf(url);
  const v6 = parseIpv6(host);
  if (v6 !== undefined) {
    if (reservedIpv6(v6)) return "reserved-address";
    return workerHosts.has(host) ? "worker-origin" : undefined;
  }
  if (host === "" || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
    return "invalid-url";
  }
  const v4 = parseIpv4(host);
  if (v4 !== undefined) {
    if (reservedIpv4.some((range) => inRange(v4, range))) return "reserved-address";
    return workerHosts.has(host) ? "worker-origin" : undefined;
  }
  if (localHostname(host)) return "local-hostname";
  if (workerHosts.has(host)) return "worker-origin";
  return undefined;
}

function workerHostsOf(workerOrigins: Option.Option<string> | ReadonlyArray<string>) {
  const origins = Option.isOption(workerOrigins) ? Option.toArray(workerOrigins) : workerOrigins;
  const hosts = new Set<string>();
  for (const origin of origins) {
    if (!URL.canParse(origin)) continue;
    hosts.add(hostOf(new URL(origin)));
  }
  return hosts;
}

/**
 * Accept an HTTPS URL on the default port, with no credentials, whose host is
 * neither a local name, nor an IP literal in a reserved range, nor the host of
 * any origin in `workerOrigins`. A hostname that resolves to a private address
 * is not detected.
 */
export function parseWebhookUrl(
  input: string,
  workerOrigins: Option.Option<string> | ReadonlyArray<string>,
): Result.Result<WebhookUrl, DestinationRefusalReason> {
  if (input.length > maxUrlLength || !URL.canParse(input)) return Result.fail("invalid-url");
  const url = new URL(input);
  const reason = refusal(url, workerHostsOf(workerOrigins));
  return reason === undefined ? Result.succeed(WebhookUrl.make(url.href)) : Result.fail(reason);
}
