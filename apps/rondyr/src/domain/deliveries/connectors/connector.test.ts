import { assert, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { DeliveryId } from "../delivery.ts";
import { airtable } from "./airtable.ts";
import { cut, type ConnectorMessage } from "./connector.ts";

const message: ConnectorMessage = {
  kind: "submission",
  id: DeliveryId.make("7c0d1e2f-3a4b-4c5d-8e6f-0a1b2c3d4e01"),
  submissionId: "submission-1",
  receivedAt: 0,
  form: { publicId: "contact", name: "Contact" },
  fields: { message: "Hello" },
};

const settings = {
  token: "patTestToken0123456789.abcdef",
  baseId: "appAbCdEfGhIjKlMn",
  table: "Leads",
};

function refusalOf(typed: typeof settings | { readonly [name: string]: string }) {
  return Result.match(airtable.parseSettings(typed), {
    onSuccess: () => "accepted",
    onFailure: ({ field, reason }) => `${field}: ${reason}`,
  });
}

it("describes each setting of a connector for the form of the dashboard", () => {
  assert.deepEqual(airtable.fields, [
    { name: "token", secret: true, optional: false },
    { name: "baseId", secret: false, optional: false },
    { name: "table", secret: false, optional: false },
    { name: "idColumn", secret: false, optional: true },
  ]);
});

it("accepts settings without an optional one, and stores them trimmed", () => {
  const parsed = airtable.parseSettings({ ...settings, table: "  Leads ", idColumn: "  " });
  assert.deepEqual(Result.getOrUndefined(parsed), settings);
});

it("names the required setting that is left out", () => {
  assert.strictEqual(refusalOf({ token: settings.token, table: "Leads" }), "baseId: missing");
});

it("names the setting whose value is not valid", () => {
  assert.strictEqual(refusalOf({ ...settings, baseId: "Leads base" }), "baseId: invalid");
});

it("refuses a setting that the connector does not have", () => {
  assert.strictEqual(refusalOf({ ...settings, channel: "#leads" }), "channel: unknown");
});

it("builds no request from stored settings that no longer fit the connector", () => {
  assert.isTrue(Option.isNone(airtable.request({ table: "Leads" }, message)));
});

it("cuts a long text to its limit, ending with an ellipsis", () => {
  assert.strictEqual(cut("abcdef", 4), "abc…");
});

it("does not split a character when it cuts a text", () => {
  assert.strictEqual(cut("ab😀cd", 4), "ab…");
});

it("keeps a text that fits its limit", () => {
  assert.strictEqual(cut("abcd", 4), "abcd");
});
