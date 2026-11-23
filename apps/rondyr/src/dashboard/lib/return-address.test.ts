import { assert, it } from "@effect/vitest";
import { Schema } from "effect";

import { isPathOf, signInSearchOf } from "./return-address.ts";

const origin = "https://forms.example.test";
const decode = Schema.decodeUnknownSync(signInSearchOf(origin));

it("keeps a path of the dashboard as the return address", () => {
  assert.deepStrictEqual(decode({ redirect: "/o/organization/messages?folder=all" }), {
    redirect: "/o/organization/messages?folder=all",
  });
});

it("ignores an address of another origin", () => {
  assert.deepStrictEqual(decode({ redirect: "https://elsewhere.example.test/" }), {});
});

it("ignores an address that the browser would resolve on another host", () => {
  assert.isFalse(isPathOf(origin, "//elsewhere.example.test/"));
  assert.isFalse(isPathOf(origin, "/\\elsewhere.example.test/"));
});

it("ignores a relative address", () => {
  assert.isFalse(isPathOf(origin, "o/organization/messages"));
});
