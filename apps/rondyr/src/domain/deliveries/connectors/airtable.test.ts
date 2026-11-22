import { assert, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { DeliveryId } from "../delivery.ts";
import { airtable } from "./airtable.ts";
import type { ConnectorMessage } from "./connector.ts";

const settings = {
  token: "patTestToken0123456789.abcdef",
  baseId: "appAbCdEfGhIjKlMn",
  table: "Leads",
};

const message: ConnectorMessage = {
  kind: "submission",
  id: DeliveryId.make("7c0d1e2f-3a4b-4c5d-8e6f-0a1b2c3d4e04"),
  submissionId: "submission-1",
  receivedAt: 0,
  form: { publicId: "contact", name: "Contact" },
  fields: { email: "customer@example.test", message: "Is there room in the class?" },
};

const refuses = (changed: Partial<typeof settings>) =>
  Result.isFailure(airtable.parseSettings({ ...settings, ...changed }));

it("adds a row with a cell per field, in the column of the same name", () => {
  assert.deepEqual(Option.getOrUndefined(airtable.request(settings, message)), {
    method: "POST",
    url: "https://api.airtable.com/v0/appAbCdEfGhIjKlMn/Leads",
    headers: { authorization: "Bearer patTestToken0123456789.abcdef" },
    body: {
      records: [
        { fields: { email: "customer@example.test", message: "Is there room in the class?" } },
      ],
      typecast: true,
    },
  });
});

it("updates the row of the submission when the table has an ID column", () => {
  const request = airtable.request({ ...settings, idColumn: "Rondyr ID" }, message);
  assert.deepEqual(Option.getOrUndefined(request), {
    method: "PATCH",
    url: "https://api.airtable.com/v0/appAbCdEfGhIjKlMn/Leads",
    headers: { authorization: "Bearer patTestToken0123456789.abcdef" },
    body: {
      records: [
        {
          fields: {
            email: "customer@example.test",
            message: "Is there room in the class?",
            "Rondyr ID": "submission-1",
          },
        },
      ],
      typecast: true,
      performUpsert: { fieldsToMergeOn: ["Rondyr ID"] },
    },
  });
});

it("writes the submission ID in the ID column, over a field of the same name", () => {
  const request = airtable.request(
    { ...settings, idColumn: "id" },
    { ...message, fields: { id: "typed by the visitor" } },
  );
  assert.deepEqual(Option.getOrUndefined(request)?.body, {
    records: [{ fields: { id: "submission-1" } }],
    typecast: true,
    performUpsert: { fieldsToMergeOn: ["id"] },
  });
});

it("adds an empty row for a test, whatever the columns of the table", () => {
  const request = airtable.request(settings, { ...message, kind: "test" });
  assert.deepEqual(Option.getOrUndefined(request)?.body, {
    records: [{ fields: {} }],
    typecast: true,
  });
});

it("encodes the name of the table in the URL", () => {
  const request = airtable.request({ ...settings, table: "Leads / 2026?" }, message);
  assert.strictEqual(
    Option.getOrUndefined(request)?.url,
    "https://api.airtable.com/v0/appAbCdEfGhIjKlMn/Leads%20%2F%202026%3F",
  );
});

it("refuses a token with a character that a header cannot carry", () => {
  assert.isTrue(refuses({ token: "patTestToken0123456789 abcdef" }));
});

it("refuses a base ID that could change the path of the request", () => {
  assert.isTrue(refuses({ baseId: "appAbCdEfGhIj/../x" }));
});

it("refuses a table name with half of a character, which a URL cannot carry", () => {
  assert.isTrue(refuses({ table: "Leads\u{d83d}" }));
});

it("refuses a table name with a line break", () => {
  assert.isTrue(refuses({ table: "Leads\n2026" }));
});
