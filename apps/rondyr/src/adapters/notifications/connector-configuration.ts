import { Schema } from "effect";

import { ConnectorSettings } from "../../domain/deliveries/connectors/connector.ts";
import { SealedSecret } from "../../ports/secret-cipher.ts";

/** `notification_targets.configuration` of a target whose type is a connector. */
export const ConnectorConfiguration = Schema.Struct({
  name: Schema.String,
  /** The settings that are not secrets. */
  settings: ConnectorSettings,
  /** Each secret setting, sealed for the target. */
  secrets: Schema.Record(Schema.String, SealedSecret),
});
