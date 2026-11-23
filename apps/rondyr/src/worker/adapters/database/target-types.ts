import { Schema } from "effect";

import { ConnectorType } from "../../../domain/deliveries/connectors/catalog.ts";

/** The types of the targets that this version lists, tests and delivers to. */
export const StoredTargetType = Schema.Literals(["webhook", "email", ...ConnectorType.literals]);

// The literals are constants of this code, never a value of a request.
const quoted = StoredTargetType.literals.map((type) => `'${type}'`).join(", ");

/** SQL that keeps the targets of a known type, for the alias `t` of `notification_targets`. */
export const listedTypes = `t.type IN (${quoted})`;
