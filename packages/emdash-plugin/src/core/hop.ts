const encoder = new TextEncoder();

declare global {
  /**
   * The isolate's enqueue key. It lives on `globalThis`, not in this module, so
   * that every copy of the module in one Worker isolate reads the same key: a
   * build can bundle the site route and the plugin into separate chunks, each
   * with its own copy of this file.
   */
  var rondyrEmdashPluginEnqueueKey: string | undefined;
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `hop_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The credential of the in-process call from the site's submission route to the
 * plugin's `enqueue` route: `RONDYR_API_TOKEN` when it is set. Without it, 32
 * random bytes that this Worker isolate creates on first use and never sends
 * anywhere, so submissions still wait in the queue until the token is set. The
 * route and the plugin run in the same isolate, so they share it.
 */
export function enqueueCredential(token: string | null): string {
  if (token !== null) return token;
  globalThis.rondyrEmdashPluginEnqueueKey ??= randomKey();
  return globalThis.rondyrEmdashPluginEnqueueKey;
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
