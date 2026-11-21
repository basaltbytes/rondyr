const encoder = new TextEncoder();
let isolateKey: string | null = null;

/**
 * The credential of the in-process call from the site's submission route to the
 * plugin's `enqueue` route: `RONDYR_API_TOKEN` when it is set. Without it, a
 * random key that this Worker isolate creates on first use and never sends
 * anywhere, so submissions still wait in the queue until the token is set. The
 * route and the plugin run in the same isolate, so they share it.
 */
export function enqueueCredential(token: string | null): string {
  if (token !== null) return token;
  isolateKey ??= `hop_${crypto.randomUUID()}`;
  return isolateKey;
}

/** Compare a received `Authorization` header with the expected credential, in constant time. */
export function matchesCredential(header: string | null, credential: string): boolean {
  const received = encoder.encode(header ?? "");
  const expected = encoder.encode(`Bearer ${credential}`);
  let difference = received.byteLength ^ expected.byteLength;
  for (let index = 0; index < expected.byteLength; index += 1) {
    difference |= (received[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}
