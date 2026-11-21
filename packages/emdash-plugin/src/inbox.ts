import { PluginRouteError, type PluginContext } from "emdash";

import { RondyrClient, RondyrError, type Organization } from "./core/rondyr-client.ts";
import type { ResolvedOptions } from "./options.ts";
import { rondyrSecrets } from "./secrets.ts";

const statusOf = {
  unreachable: 502,
  unauthorized: 502,
  "not-found": 404,
  conflict: 409,
  unexpected: 502,
} as const;

/**
 * A client of the Rondyr API with the site's token, or the route error
 * `token-missing` or `token-malformed`.
 */
export function rondyrClient(ctx: PluginContext, options: ResolvedOptions): RondyrClient {
  const { token, tokenProblem } = rondyrSecrets();
  const http = ctx.http;
  if (token === null) {
    throw new PluginRouteError(
      tokenProblem ?? "token-missing",
      "RONDYR_API_TOKEN is not usable",
      503,
    );
  }
  if (http === undefined) throw new PluginRouteError("unexpected", "Network access is off", 503);
  return new RondyrClient((url, init) => http.fetch(url, init), options.url, token);
}

/**
 * Run a Rondyr call from a route. A Rondyr failure becomes a route error whose
 * code the admin page reads: `unreachable`, `unauthorized`, `not-found`,
 * `conflict` or `unexpected`. Nothing is cached, so nothing stale is shown.
 */
export async function withRondyr<T>(
  ctx: PluginContext,
  options: ResolvedOptions,
  call: (client: RondyrClient, organization: Organization) => Promise<T>,
): Promise<T> {
  const client = rondyrClient(ctx, options);
  try {
    return await call(client, await client.organization());
  } catch (error) {
    if (!(error instanceof RondyrError)) throw error;
    throw new PluginRouteError(error.failure, error.message, statusOf[error.failure]);
  }
}
