/** A Rondyr API token: `rdr_` followed by 32 random bytes in unpadded base64url. */
const apiToken = /^rdr_[A-Za-z0-9_-]{43}$/u;

/** Why there is no usable token: unset, or set to something that is not a Rondyr API token. */
export type TokenProblem = "token-missing" | "token-malformed";

export interface RondyrSecrets {
  /** `RONDYR_API_TOKEN`, when it is a Rondyr API token. */
  readonly token: string | null;
  readonly tokenProblem: TokenProblem | null;
  /**
   * `RONDYR_WEBHOOK_SECRET`: the signing secrets of the site's Rondyr webhook
   * destinations, separated by spaces, commas or line breaks. Rondyr gives
   * each webhook its own secret, so a site linked to several Rondyr forms
   * lists one per form.
   */
  readonly webhookSecrets: readonly string[];
}

function present(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function problemOf(value: string | null): TokenProblem | null {
  if (value === null) return "token-missing";
  return apiToken.test(value) ? null : "token-malformed";
}

/**
 * Both secrets are optional: a missing one disables what needs it, nothing
 * else. A token that is not a Rondyr API token is never used, so a badly
 * pasted value can't reach a request header, and so can't reach a log.
 */
export function readSecrets(
  token: string | undefined,
  webhookSecret: string | undefined,
): RondyrSecrets {
  const value = present(token);
  const tokenProblem = problemOf(value);
  return {
    token: tokenProblem === null ? value : null,
    tokenProblem,
    webhookSecrets: (webhookSecret ?? "").split(/[\s,]+/u).filter((secret) => secret !== ""),
  };
}
