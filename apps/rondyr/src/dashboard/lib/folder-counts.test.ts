import { assert, it } from "@effect/vitest";

import type { Inbox } from "./inbox-client.ts";

import {
  countsAfterMove,
  countsAfterRemoval,
  countsOfForm,
  formsOfFolder,
  totalOf,
} from "./folder-counts.ts";

const none = { received: 0, classifying: 0, accepted: 0, quarantined: 0, archived: 0 };
const statuses = { received: 1, classifying: 2, accepted: 30, quarantined: 4, archived: 500 };
const contactCounts = { ...statuses, quarantined: 3 };
const quotesCounts = { ...none, quarantined: 1 };
const counts = {
  ...statuses,
  forms: [
    { publicId: "contact", counts: contactCounts },
    { publicId: "quotes", counts: quotesCounts },
  ],
};

function form(publicId: string): Inbox["forms"][number] {
  return {
    name: publicId,
    publicId,
    status: "active",
    emoji: null,
    businessContext: null,
    successUrl: null,
    honeypotField: null,
    turnstileSiteKey: null,
  };
}

const contact = form("contact");
const quotes = form("quotes");
const press = form("press");

it("counts the messages of one status for the folder of that status", () => {
  assert.strictEqual(totalOf(counts, "quarantined"), 4);
});

it("counts the messages of every status for the folder of all messages", () => {
  assert.strictEqual(totalOf(counts, "all"), 537);
});

it("takes an accepted message out of the messages to review", () => {
  const after = countsAfterMove(counts, "contact", "quarantined", "accepted");

  assert.strictEqual(after.quarantined, 3);
});

it("adds an accepted message to the accepted messages", () => {
  const after = countsAfterMove(counts, "contact", "quarantined", "accepted");

  assert.strictEqual(after.accepted, 31);
});

it("adds an archived message to the archived messages", () => {
  const after = countsAfterMove(counts, "contact", "quarantined", "archived");

  assert.strictEqual(after.archived, 501);
});

it("leaves the other statuses as they were", () => {
  const { forms: _forms, ...after } = countsAfterMove(counts, "contact", "quarantined", "archived");

  assert.deepEqual(after, { ...statuses, quarantined: 3, archived: 501 });
});

it("keeps the same number of messages in all", () => {
  const after = countsAfterMove(counts, "contact", "quarantined", "accepted");

  assert.strictEqual(totalOf(after, "all"), 537);
});

it("changes nothing for a message that keeps its status", () => {
  assert.deepEqual(countsAfterMove(counts, "contact", "accepted", "accepted"), counts);
});

it("keeps a count at zero when it is already empty", () => {
  const after = countsAfterMove(
    { ...counts, quarantined: 0 },
    "contact",
    "quarantined",
    "accepted",
  );

  assert.strictEqual(after.quarantined, 0);
});

it("moves the message in the counts of its form", () => {
  const after = countsAfterMove(counts, "contact", "quarantined", "accepted");

  assert.deepEqual(countsOfForm(after, "contact"), {
    ...contactCounts,
    quarantined: 2,
    accepted: 31,
  });
});

it("leaves the counts of the other forms as they were", () => {
  const after = countsAfterMove(counts, "contact", "quarantined", "accepted");

  assert.deepEqual(countsOfForm(after, "quotes"), quotesCounts);
});

it("counts a decided message for a form that had no counts yet", () => {
  const after = countsAfterMove(counts, "press", "quarantined", "accepted");

  assert.deepEqual(countsOfForm(after, "press"), { ...none, accepted: 1 });
});

it("counts no message for a form that has none", () => {
  assert.deepEqual(countsOfForm(counts, "press"), none);
});

it("unfolds a folder into the forms that have a message in it", () => {
  const rows = formsOfFolder([contact, quotes, press], counts, "quarantined", null);

  assert.deepEqual(rows, [
    { form: contact, total: 3 },
    { form: quotes, total: 1 },
  ]);
});

it("does not unfold a folder whose messages all come from one form", () => {
  const rows = formsOfFolder([contact, quotes, press], counts, "accepted", null);

  assert.deepEqual(rows, []);
});

it("does not unfold a folder of an organization with one form", () => {
  const single = { ...contactCounts, forms: [{ publicId: "contact", counts: contactCounts }] };

  const rows = formsOfFolder([contact], single, "quarantined", null);

  assert.deepEqual(rows, []);
});

it("keeps the open form in its folder once its last message has left", () => {
  const rows = formsOfFolder([contact, quotes, press], counts, "quarantined", "press");

  assert.deepEqual(rows, [
    { form: contact, total: 3 },
    { form: quotes, total: 1 },
    { form: press, total: 0 },
  ]);
});

it("keeps a folder unfolded while its only form with a message is the open one", () => {
  const rows = formsOfFolder([contact, quotes, press], counts, "accepted", "contact");

  assert.deepEqual(rows, [{ form: contact, total: 30 }]);
});

it("removes a deleted message from its status, for the organization and its form", () => {
  const known = {
    received: 0,
    classifying: 0,
    accepted: 2,
    quarantined: 1,
    archived: 0,
    forms: [
      {
        publicId: "contact",
        counts: { received: 0, classifying: 0, accepted: 2, quarantined: 0, archived: 0 },
      },
      {
        publicId: "orders",
        counts: { received: 0, classifying: 0, accepted: 0, quarantined: 1, archived: 0 },
      },
    ],
  };

  const after = countsAfterRemoval(known, "contact", "accepted");

  assert.strictEqual(after.accepted, 1);
  assert.strictEqual(after.quarantined, 1);
  assert.strictEqual(
    after.forms.find(({ publicId }) => publicId === "contact")?.counts.accepted,
    1,
  );
  assert.strictEqual(countsAfterRemoval(after, "orders", "archived").archived, 0);
});
