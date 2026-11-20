import { Result, Schema } from "effect";

/** Why an origin cannot be added to the allowed origins of a form. */
export const OriginRefusalReason = Schema.Literals([
  "invalid-origin",
  "wildcard",
  "not-https",
  "credentials",
  "not-an-origin",
]);
export type OriginRefusalReason = typeof OriginRefusalReason.Type;

/**
 * A browser origin as `parseAllowedOrigin` normalizes it: a scheme, a host and
 * an optional port, with no trailing slash. It is the value browsers send in
 * the `Origin` header.
 */
export const AllowedOrigin = Schema.String.pipe(Schema.brand("AllowedOrigin"));
export type AllowedOrigin = typeof AllowedOrigin.Type;

const maxOriginLength = 2048;

// Lowercase DNS labels separated by dots, which also matches a dotted IPv4
// address. The URL parser has already lowercased the host and converted an
// internationalized name to its ASCII form.
const hostname = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/u;
const ipv6 = /^\[[0-9a-f:.]+\]$/u;
const loopbackIpv4 = /^127(?:\.\d{1,3}){3}$/u;

function loopback(url: URL) {
  return (
    url.hostname === "localhost" || url.hostname === "[::1]" || loopbackIpv4.test(url.hostname)
  );
}

function refusal(input: string, url: URL): OriginRefusalReason | undefined {
  if (input.includes("*")) return "wildcard";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url))) {
    return "not-https";
  }
  if (url.username !== "" || url.password !== "") return "credentials";
  if (!hostname.test(url.hostname) && !ipv6.test(url.hostname)) return "invalid-origin";
  // A path, a query or a fragment, even an empty one.
  if (url.href !== `${url.origin}/`) return "not-an-origin";
  return undefined;
}

/**
 * Accept an HTTPS origin, or an HTTP origin on `localhost` or a loopback
 * address for development, and normalize it: lowercase scheme and host, no
 * default port, no trailing slash. A path, a query, credentials or a wildcard
 * are refused.
 */
export function parseAllowedOrigin(
  input: string,
): Result.Result<AllowedOrigin, OriginRefusalReason> {
  const trimmed = input.trim();
  if (trimmed.length > maxOriginLength || !URL.canParse(trimmed)) {
    return Result.fail(trimmed.includes("*") ? "wildcard" : "invalid-origin");
  }
  const url = new URL(trimmed);
  const reason = refusal(trimmed, url);
  return reason === undefined
    ? Result.succeed(AllowedOrigin.make(url.origin))
    : Result.fail(reason);
}

/** An allowed origin of a form, as the admin API returns it. */
export const FormOrigin = Schema.Struct({
  origin: Schema.String,
  /** Milliseconds since the epoch. */
  createdAt: Schema.Int,
});

export const AddFormOrigin = Schema.Struct({
  origin: Schema.String.check(Schema.isMaxLength(maxOriginLength)),
});

export const OriginRequestError = Schema.Union([
  Schema.Struct({
    error: Schema.Literal("origin-refused"),
    reason: OriginRefusalReason,
  }),
  // The form's success URL is on this origin: clear the success URL first.
  Schema.Struct({ error: Schema.Literal("origin-in-use") }),
]);
