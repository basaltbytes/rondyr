const toleranceSeconds = 300;
const encoder = new TextEncoder();

function hexBytes(hex: string) {
  if (!/^[0-9a-f]{64}$/u.test(hex)) return null;
  return Uint8Array.from(hex.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

/**
 * Returns the raw body of a Rondyr webhook request when one of its signatures
 * matches `secret` and its timestamp is at most five minutes away from `now`,
 * in milliseconds. Returns null otherwise.
 */
export async function verifyRondyrWebhook(request: Request, secret: string, now = Date.now()) {
  const timestamp = request.headers.get("rondyr-timestamp") ?? "";
  const header = request.headers.get("rondyr-signature") ?? "";
  if (!/^\d+$/u.test(timestamp)) return null;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return null;

  const body = await request.text();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = encoder.encode(`${timestamp}.${body}`);
  for (const part of header.split(",")) {
    const [scheme, value = ""] = part.trim().split("=", 2);
    const signature = scheme === "v1" ? hexBytes(value) : null;
    // crypto.subtle.verify compares in constant time.
    if (signature !== null && (await crypto.subtle.verify("HMAC", key, signature, signed))) {
      return body;
    }
  }
  return null;
}
