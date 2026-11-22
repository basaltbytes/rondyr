import { Result, Schema } from "effect";

import { TargetId } from "../delivery.ts";
import { connectorOf, ConnectorType } from "./catalog.ts";
import { ConnectorSettings, lineOf, oneLine, SettingsRefusal } from "./connector.ts";

export const maxDestinationNameLength = 80;

/** The name an admin gives a destination, to tell it from the others of its form. */
export const DestinationName = lineOf(maxDestinationNameLength).pipe(
  Schema.brand("DestinationName"),
);

/** A destination of a connector as the admin API returns it, without its secrets. */
export const ConnectorTarget = Schema.Struct({
  id: TargetId,
  type: ConnectorType,
  name: Schema.String,
  /** The settings that are not secrets. A secret is set, and never returned. */
  settings: ConnectorSettings,
  active: Schema.Boolean,
  createdAt: Schema.Int,
});

// Settings are checked by `parseConnectorDestination`, which names the refused one.
const SettingsInput = Schema.Record(
  Schema.String.check(Schema.isMaxLength(64)),
  Schema.String.check(Schema.isMaxLength(4096)),
).check(
  Schema.makeFilter(
    (settings) => Object.keys(settings).length <= 16 || "Expected at most 16 settings",
  ),
);

/** A new destination of a connector, or the new name and settings of one. */
export const CreateConnectorTarget = Schema.Struct({
  type: ConnectorType,
  name: Schema.String.check(Schema.isMaxLength(400)),
  /** Every setting, secrets included: none is kept from the destination it replaces. */
  settings: SettingsInput,
});

/** Why a destination of a connector is refused. */
export const ConnectorRefusal = Schema.Union([
  Schema.Struct({ error: Schema.Literal("name-refused") }),
  Schema.Struct({ error: Schema.Literal("settings-refused"), ...SettingsRefusal.fields }),
]);

/** A name and settings that passed `parseConnectorDestination`. */
export const ConnectorDestination = Schema.Struct({
  type: ConnectorType,
  name: DestinationName,
  settings: ConnectorSettings,
}).pipe(Schema.brand("ConnectorDestination"));
export type ConnectorDestination = typeof ConnectorDestination.Type;

const isName = Schema.is(DestinationName);

/** Check the name and, with the connector of its type, the settings of a destination. */
export function parseConnectorDestination(
  input: typeof CreateConnectorTarget.Type,
): Result.Result<ConnectorDestination, typeof ConnectorRefusal.Type> {
  const name = oneLine(input.name);
  if (!isName(name)) return Result.fail({ error: "name-refused" });
  return Result.mapBoth(connectorOf(input.type).parseSettings(input.settings), {
    onSuccess: (settings) => ConnectorDestination.make({ type: input.type, name, settings }),
    onFailure: (refusal) => ({ error: "settings-refused" as const, ...refusal }),
  });
}
