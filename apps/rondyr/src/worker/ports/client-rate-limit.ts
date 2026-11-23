import { Context, Effect } from "effect";

/**
 * A limit on the submissions that one client sends to one form, counted before
 * anything is stored. It keeps a single client from filling the form's own cap.
 */
export class ClientRateLimit extends Context.Service<
  ClientRateLimit,
  {
    /**
     * Count one submission from `clientAddress`, the IP address of the client,
     * to the form `publicId`, and tell whether the client is under its limit.
     * A counter that cannot answer admits the submission: the form's cap still applies.
     */
    readonly admit: (publicId: string, clientAddress: string) => Effect.Effect<boolean>;
  }
>()("rondyr/worker/ports/client-rate-limit/ClientRateLimit") {}
