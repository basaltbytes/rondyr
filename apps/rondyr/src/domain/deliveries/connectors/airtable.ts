import { Schema } from "effect";

import { defineConnector, lineOf, type ConnectorMessage } from "./connector.ts";

// https://airtable.com/developers/web/api/create-records
// https://airtable.com/developers/web/api/update-multiple-records

/** A personal access token. Its characters are safe in a header. */
export const AirtableToken = Schema.String.check(
  Schema.makeFilter(
    (token: string) =>
      /^[\w.-]{20,200}$/u.test(token) || "Expected an Airtable personal access token",
  ),
).pipe(Schema.brand("AirtableToken"));

/** The ID of a base, which starts its URL: `https://airtable.com/appXXXXXXXXXXXXXX/...`. */
export const AirtableBaseId = Schema.String.check(
  Schema.makeFilter(
    (id: string) =>
      /^app[A-Za-z0-9]{14}$/u.test(id) || "Expected a base ID such as appXXXXXXXXXXXXXX",
  ),
).pipe(Schema.brand("AirtableBaseId"));

export const AirtableSettings = Schema.Struct({
  token: AirtableToken,
  baseId: AirtableBaseId,
  /** The name of the table, or its ID, which starts with `tbl`. */
  table: lineOf(255),
  /**
   * A column that gets the submission ID. With it, Rondyr updates the row of a
   * submission it already sent, so a retry never adds a second row. A form field
   * of the same name loses its value to the ID: rows are matched on this column,
   * and a visitor must not choose which row a message replaces.
   */
  idColumn: Schema.optionalKey(lineOf(255)),
});

type Settings = typeof AirtableSettings.Type;

/**
 * One row per submission, with one cell per field, in the column of the same
 * name. Airtable converts each value to the type of its column. A test adds a
 * row that is empty, or that has only the ID column.
 */
export function airtableRecord({ idColumn }: Settings, message: ConnectorMessage) {
  const id = idColumn === undefined ? {} : { [idColumn]: message.submissionId };
  const fields = message.kind === "test" ? id : { ...message.fields, ...id };
  return { records: [{ fields }], typecast: true };
}

/** Adds each accepted message as a row of an Airtable table. */
export const airtable = defineConnector({
  type: "airtable",
  label: "Airtable",
  hosts: ["api.airtable.com"],
  settings: AirtableSettings,
  secrets: ["token"],
  request: (settings, message) => {
    const record = airtableRecord(settings, message);
    const { idColumn } = settings;
    const table = `https://api.airtable.com/v0/${settings.baseId}/${encodeURIComponent(settings.table)}`;
    const headers = { authorization: `Bearer ${settings.token}` };
    return idColumn === undefined
      ? { method: "POST", url: table, headers, body: record }
      : {
          method: "PATCH",
          url: table,
          headers,
          body: { ...record, performUpsert: { fieldsToMergeOn: [idColumn] } },
        };
  },
  statusHints: new Map([
    [401, "Airtable refused the token. Create a personal access token and save it."],
    [
      403,
      "Airtable refuses the token for this table, or does not find the base or the table. Check the base ID and the table, and that the token has the data.records:write scope and access to the base.",
    ],
    [404, "Airtable did not find the base or the table."],
    [
      422,
      "Airtable refused the row. The table needs a column for each field of the form, with the same name, and the ID column when one is set.",
    ],
  ]),
});
