import { assert, it } from "@effect/vitest";

import { unfoldedFrom } from "./unfolded-folders.ts";

it("unfolds the messages to review when the browser stored no choice", () => {
  assert.deepEqual(unfoldedFrom(null), ["quarantined"]);
});

it("unfolds the folders that the browser stored", () => {
  assert.deepEqual(unfoldedFrom("accepted,all"), ["accepted", "all"]);
});

it("unfolds no folder when the stored choice is to fold them all", () => {
  assert.deepEqual(unfoldedFrom(""), []);
});

it("ignores a stored name that is not a folder", () => {
  assert.deepEqual(unfoldedFrom("accepted,drafts"), ["accepted"]);
});
