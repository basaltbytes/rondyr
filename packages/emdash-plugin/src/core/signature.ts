const toleranceSeconds = 300;
const encoder = new TextEncoder();

export type WebhookVerdict = "valid" | "invalid-signature" | "stale-timestamp";

function hexBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]{64}$/u.test(hex)) return null;
  return Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

/**
 * Check a Rondyr webhook as docs/webhooks.md describes it: HMAC-SHA-256 of
 * `<timestamp>.<body>` over the exact bytes received, one of up to two `v1=`
 * signatures matching, and a timestamp at most five minutes from `now`
 * (Unix milliseconds). The comparison is constant-time.
 */
export async function verifyWebhook(
  body: Uint8Array,
  headers: Headers,
  secret: string,
  now: number,
): Promise<WebhookVerdict> {
  const timestamp = headers.get("rondyr-timestamp") ?? "";
  const header = headers.get("rondyr-signature") ?? "";
  if (!/^\d{1,12}$/u.test(timestamp)) return "invalid-signature";
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return "stale-timestamp";
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix);
  signed.set(body, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  for (const part of header.split(",").slice(0, 2)) {
    const [scheme, value = ""] = part.trim().split("=", 2);
    const signature = scheme === "v1" ? hexBytes(value) : null;
    if (signature !== null && (await crypto.subtle.verify("HMAC", key, signature, signed))) {
      return "valid";
    }
  }
  return "invalid-signature";
}
