import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "dashboard",
    include: ["**/*.test.ts"],
    // Dates are shown in the reader's time zone. A fixed zone with daylight saving
    // time gives the same results on every machine and covers the days of 23 and 25 hours.
    env: { TZ: "Europe/Paris" },
  },
});
