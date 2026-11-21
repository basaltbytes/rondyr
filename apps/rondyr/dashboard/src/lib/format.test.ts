import { assert, it } from "@effect/vitest";

import { formats } from "./format.ts";

// Local time, in the Europe/Paris zone of dashboard/vitest.config.ts.
const morning = new Date(2026, 10, 18, 9, 5).getTime();

it("writes a time of the day with two digits for the hour in English", () => {
  assert.strictEqual(formats.en.timeOfDay(morning), "09:05");
});

it("writes a time of the day with two digits for the hour in French", () => {
  assert.strictEqual(formats.fr.timeOfDay(morning), "09:05");
});

it("writes a day with the short English name of its month", () => {
  assert.strictEqual(formats.en.dayOfYear(morning), "18 Nov");
});

it("writes a day with the short French name of its month", () => {
  assert.strictEqual(formats.fr.dayOfYear(morning), "18 nov.");
});
