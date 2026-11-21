import { Schema } from "effect";

import { SealedSecret } from "../../ports/secret-cipher.ts";

/** `notification_targets.configuration` of a target of type `webhook`. */
export const WebhookConfiguration = Schema.Struct({
  url: Schema.String,
  secret: SealedSecret,
  /** The secret before the last rotation, which also signs until `expiresAt`. */
  previousSecret: Schema.NullOr(Schema.Struct({ secret: SealedSecret, expiresAt: Schema.Int })),
});
