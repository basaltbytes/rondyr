import { Schema } from "effect";

import { airtable } from "./airtable.ts";
import type { Connector } from "./connector.ts";
import { discord } from "./discord.ts";
import { slack } from "./slack.ts";

/** The type of a destination that a connector sends to. */
export const ConnectorType = Schema.Literals(["discord", "slack", "airtable"]);
export type ConnectorType = typeof ConnectorType.Type;

// A connector is listed here once, under its own type. Its texts in the
// dashboard are the keys `inbox.connectors.<type>` of both locale files.
const catalog = { discord, slack, airtable } satisfies {
  readonly [Type in ConnectorType]: Connector<Type>;
};

/** Every connector, in the order of the dashboard. */
export const connectors: ReadonlyArray<Connector<ConnectorType>> = ConnectorType.literals.map(
  (type) => catalog[type],
);

export function connectorOf(type: ConnectorType): Connector<ConnectorType> {
  return catalog[type];
}
