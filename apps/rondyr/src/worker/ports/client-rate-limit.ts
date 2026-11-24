import { Context, Effect } from "effect";

/**
 * A per-client rate limit counted before work runs or rows are stored,
 * partitioned by `scope` (a form's public ID or a public endpoint name).
 */
export class ClientRateLimit extends Context.Service<
  ClientRateLimit,
  {
    /**
     * Count one request from `clientAddress`, the IP address of the client,
     * under `scope`, and tell whether the client is under its limit.
     * A counter that cannot answer admits the request.
     */
    readonly admit: (scope: string, clientAddress: string) => Effect.Effect<boolean>;
  }
>()("rondyr/worker/ports/client-rate-limit/ClientRateLimit") {}
