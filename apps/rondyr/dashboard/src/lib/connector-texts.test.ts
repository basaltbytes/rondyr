import { assert, it } from "@effect/vitest";
import { Schema } from "effect";

import { connectors } from "@rondyr/deliveries/connectors/catalog";

import en from "~/locales/en/translation.json" with { type: "json" };
import fr from "~/locales/fr/translation.json" with { type: "json" };

// The dashboard reads the texts of a setting by the name that the connector
// gives it, so the type check of the locale files cannot tell that one is missing.
const Texts = Schema.Record(
  Schema.String,
  Schema.Struct({
    about: Schema.String.check(Schema.isMinLength(1)),
    fields: Schema.Record(
      Schema.String,
      Schema.Struct({
        label: Schema.String.check(Schema.isMinLength(1)),
        hint: Schema.String.check(Schema.isMinLength(1)),
      }),
    ),
  }),
);
const read = Schema.decodeUnknownSync(Texts);

/** The settings of the catalog, as `type.name`, that have no label and help in `types`. */
function settingsWithoutTexts(types: typeof Texts.Type) {
  return connectors.flatMap((connector) =>
    connector.fields
      .filter(({ name }) => types[connector.type]?.fields[name] === undefined)
      .map(({ name }) => `${connector.type}.${name}`),
  );
}

it("has an English label and help for every setting of every connector", () => {
  assert.deepEqual(settingsWithoutTexts(read(en.inbox.connectors.types)), []);
});

it("has a French label and help for every setting of every connector", () => {
  assert.deepEqual(settingsWithoutTexts(read(fr.inbox.connectors.types)), []);
});
