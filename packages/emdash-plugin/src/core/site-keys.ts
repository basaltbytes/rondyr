import type { Organization } from "./rondyr-client.ts";

/** How long the site keys read from Rondyr serve page renders. */
export const siteKeysFreshMs = 180_000;

/** How long page renders go without asking Rondyr again after a failed read. */
export const siteKeysRetryMs = 30_000;

/** How long one page render waits for Rondyr's answer. */
export const siteKeyTimeoutMs = 3000;

interface Known {
  readonly token: string | null;
  keys: ReadonlyMap<string, string | null> | null;
  nextReadAt: number;
}

/**
 * The Turnstile site keys of the organization's Rondyr forms, for the pages
 * that render a declared form. A page render never fails on Rondyr: when the
 * read fails, it gets the key of the last successful read, or null before one,
 * and Rondyr is asked again 30 seconds later. A new token starts over.
 *
 * Only settled values are kept between requests, never the promise of a read
 * that another request started: a Worker can't wait on another request's I/O.
 */
export function siteKeyReader(now: () => number = Date.now) {
  let known: Known | undefined;
  return async (
    token: string | null,
    rondyrFormId: string,
    read: () => Promise<Organization>,
  ): Promise<string | null> => {
    if (known?.token !== token) known = { token, keys: null, nextReadAt: 0 };
    const current = known;
    if (now() >= current.nextReadAt) {
      // With keys in hand, concurrent renders use them while this one asks.
      if (current.keys !== null) current.nextReadAt = now() + siteKeysRetryMs;
      try {
        const { forms } = await read();
        current.keys = new Map(forms.map((form) => [form.publicId, form.turnstileSiteKey]));
        current.nextReadAt = now() + siteKeysFreshMs;
      } catch {
        current.nextReadAt = now() + siteKeysRetryMs;
      }
    }
    return current.keys?.get(rondyrFormId) ?? null;
  };
}
