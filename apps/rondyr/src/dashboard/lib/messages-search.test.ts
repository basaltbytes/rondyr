import { assert, it } from "@effect/vitest";
import { Schema } from "effect";

import { MessagesSearch, messagesSearch, searchTransition } from "./messages-search.ts";

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

it("clears an active search when the input becomes empty or whitespace", () => {
  assert.deepStrictEqual(searchTransition("   ", "needle"), { action: "clear" });
  assert.deepStrictEqual(searchTransition("", null), { action: "unchanged" });
});

it("marks short inputs and notes whether an active search should clear", () => {
  assert.deepStrictEqual(searchTransition("ab", null), { action: "too-short", clearActive: false });
  assert.deepStrictEqual(searchTransition("ab", "abc"), { action: "too-short", clearActive: true });
});

it("starts a trimmed search only when it differs from the active search", () => {
  assert.deepStrictEqual(searchTransition("  needle ", null), {
    action: "search",
    query: "needle",
  });
  assert.deepStrictEqual(searchTransition("  needle ", "needle"), { action: "unchanged" });
});
