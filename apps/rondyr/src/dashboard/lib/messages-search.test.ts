import { assert, it } from "@effect/vitest";
import { Schema } from "effect";

import { MessagesSearch, messagesSearch } from "./messages-search.ts";

const decode = Schema.decodeUnknownSync(MessagesSearch);

it("opens the messages to review when the address names no folder", () => {
  assert.deepStrictEqual(decode({}), { folder: "quarantined" });
});

it("keeps the folder, the form and the text of an address", () => {
  assert.deepStrictEqual(decode({ folder: "accepted", form: "contact", q: "needle" }), {
    folder: "accepted",
    form: "contact",
    q: "needle",
  });
});

it("replaces an unknown folder with the default instead of failing", () => {
  assert.deepStrictEqual(decode({ folder: "spam" }), { folder: "quarantined" });
});

it("empties a text shorter than a search and an empty form", () => {
  assert.deepStrictEqual(decode({ folder: "all", form: "", q: "ab" }), {
    folder: "all",
    form: undefined,
    q: undefined,
  });
});

it("trims the searched text", () => {
  assert.deepStrictEqual(decode({ q: "  needle  " }), { folder: "quarantined", q: "needle" });
});

it("leaves the form and the text out of the search params when there are none", () => {
  assert.deepStrictEqual(messagesSearch("archived", null, null), { folder: "archived" });
});
