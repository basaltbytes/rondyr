import { assert, it } from "@effect/vitest";

import { parseSearch, stringifySearch } from "./search-params.ts";

it("reads every search param as a text, digits included", () => {
  assert.deepStrictEqual(parseSearch("?q=123&folder=all"), { q: "123", folder: "all" });
});

it("writes texts without quotes and leaves out the params without a value", () => {
  assert.strictEqual(
    stringifySearch({ folder: "all", q: "two words", form: undefined }),
    "?folder=all&q=two+words",
  );
});

it("writes nothing for no search params", () => {
  assert.strictEqual(stringifySearch({}), "");
});
