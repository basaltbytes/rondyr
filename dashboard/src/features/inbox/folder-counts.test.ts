import { assert, it } from "@effect/vitest";

import { countsAfterMove, totalOf } from "./folder-counts.ts";

const counts = { received: 1, classifying: 2, accepted: 30, quarantined: 4, archived: 500 };

it("counts the messages of one status for the folder of that status", () => {
  assert.strictEqual(totalOf(counts, "quarantined"), 4);
});

it("counts the messages of every status for the folder of all messages", () => {
  assert.strictEqual(totalOf(counts, "all"), 537);
});

it("takes an accepted message out of the messages to review", () => {
  const after = countsAfterMove(counts, "quarantined", "accepted");

  assert.strictEqual(after.quarantined, 3);
});

it("adds an accepted message to the accepted messages", () => {
  const after = countsAfterMove(counts, "quarantined", "accepted");

  assert.strictEqual(after.accepted, 31);
});

it("adds an archived message to the archived messages", () => {
  const after = countsAfterMove(counts, "quarantined", "archived");

  assert.strictEqual(after.archived, 501);
});

it("leaves the other statuses as they were", () => {
  const after = countsAfterMove(counts, "quarantined", "archived");

  assert.deepEqual(after, { ...counts, quarantined: 3, archived: 501 });
});

it("keeps the same number of messages in all", () => {
  const after = countsAfterMove(counts, "quarantined", "accepted");

  assert.strictEqual(totalOf(after, "all"), 537);
});

it("changes nothing for a message that keeps its status", () => {
  assert.deepEqual(countsAfterMove(counts, "accepted", "accepted"), counts);
});

it("keeps a count at zero when it is already empty", () => {
  const after = countsAfterMove({ ...counts, quarantined: 0 }, "quarantined", "accepted");

  assert.strictEqual(after.quarantined, 0);
});
