import { expect, it } from "vitest";

import type { Organization } from "./rondyr-client.ts";
import { siteKeyReader, siteKeysFreshMs, siteKeysRetryMs } from "./site-keys.ts";

const token = `rdr_${"C".repeat(43)}`;

function organization(turnstileSiteKey: string | null): Organization {
  return {
    id: "organization",
    name: "Site",
    forms: [{ publicId: "contact", name: "Contact", status: "active", turnstileSiteKey }],
  };
}

/** Rondyr answering each read with the next outcome: a site key, or null for a failure. */
function rondyr(outcomes: readonly ({ readonly key: string | null } | null)[]) {
  let reads = 0;
  return {
    reads: () => reads,
    read: async () => {
      const outcome = outcomes[reads];
      reads += 1;
      if (outcome === null || outcome === undefined) throw new Error("Rondyr is unreachable");
      return organization(outcome.key);
    },
  };
}

it("reads the forms once for three minutes, then again", async () => {
  let now = 0;
  const siteKey = siteKeyReader(() => now);
  const { read, reads } = rondyr([{ key: "first" }, { key: "second" }]);

  expect(await siteKey(token, "contact", read)).toBe("first");
  now = siteKeysFreshMs - 1;
  expect(await siteKey(token, "contact", read)).toBe("first");
  expect(await siteKey(token, "unknown", read)).toBeNull();
  expect(reads()).toBe(1);

  now = siteKeysFreshMs;
  expect(await siteKey(token, "contact", read)).toBe("second");
  expect(reads()).toBe(2);
});

it("keeps the last key while Rondyr is unreachable and asks again 30 seconds later", async () => {
  let now = 0;
  const siteKey = siteKeyReader(() => now);
  const { read, reads } = rondyr([{ key: "first" }, null, { key: "second" }]);
  await siteKey(token, "contact", read);

  now = siteKeysFreshMs;
  expect(await siteKey(token, "contact", read)).toBe("first");
  now += siteKeysRetryMs - 1;
  expect(await siteKey(token, "contact", read)).toBe("first");
  expect(reads()).toBe(2);

  now += 1;
  expect(await siteKey(token, "contact", read)).toBe("second");
  expect(reads()).toBe(3);
});

it("answers null without a first read, and does not ask on every render", async () => {
  let now = 0;
  const siteKey = siteKeyReader(() => now);
  const { read, reads } = rondyr([null, { key: "first" }]);

  expect(await siteKey(token, "contact", read)).toBeNull();
  now = siteKeysRetryMs - 1;
  expect(await siteKey(token, "contact", read)).toBeNull();
  expect(reads()).toBe(1);

  now = siteKeysRetryMs;
  expect(await siteKey(token, "contact", read)).toBe("first");
});

it("starts over with another token", async () => {
  const siteKey = siteKeyReader(() => 0);
  const { read, reads } = rondyr([{ key: "first" }, null, { key: "other" }]);
  await siteKey(token, "contact", read);

  expect(await siteKey(null, "contact", read)).toBeNull();
  expect(await siteKey(`rdr_${"D".repeat(43)}`, "contact", read)).toBe("other");
  expect(reads()).toBe(3);
});

it("lets a concurrent render use the keys in hand while another one asks", async () => {
  let now = 0;
  const siteKey = siteKeyReader(() => now);
  const first = rondyr([{ key: "first" }]);
  await siteKey(token, "contact", first.read);
  now = siteKeysFreshMs;
  const slow = Promise.withResolvers<Organization>();
  let reads = 0;
  const read = () => {
    reads += 1;
    return slow.promise;
  };

  const asking = siteKey(token, "contact", read);
  expect(await siteKey(token, "contact", read)).toBe("first");
  slow.resolve(organization("second"));

  expect(await asking).toBe("second");
  expect(reads).toBe(1);
});
