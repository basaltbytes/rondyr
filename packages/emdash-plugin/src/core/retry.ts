/** Delays before the next attempt after the first, second, … failure; then every 6 hours. */
export const retryDelaysMs = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000] as const;

/** After this long in the queue, a retryable failure marks the entry as failed. */
export const retryWindowMs = 7 * 24 * 3_600_000;

/** How long Rondyr gets to answer one attempt before it counts as a network error. */
export const attemptTimeoutMs = 30_000;

/**
 * How long one attempt holds an entry: longer than an attempt can last, so two
 * attempts never send the same entry at once.
 */
export const attemptLeaseMs = 4 * attemptTimeoutMs;

/** How long to wait after the given number of consecutive failures, at least one. */
export function retryDelayMs(failures: number): number {
  return retryDelaysMs[Math.min(Math.max(failures, 1), retryDelaysMs.length) - 1] ?? 21_600_000;
}

/**
 * What a response of `POST /f/:publicId` means for a queue entry. `null` is a
 * network error or a timeout. Only `202` means Rondyr stored the submission;
 * `429` and `5xx` are worth another attempt; any other status will not change.
 */
export type SendOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "retry"; readonly status: number | null }
  | { readonly kind: "refused"; readonly status: number };

export function sendOutcome(status: number | null): SendOutcome {
  if (status === 202) return { kind: "accepted" };
  if (status === null || status === 429 || status >= 500) return { kind: "retry", status };
  return { kind: "refused", status };
}
