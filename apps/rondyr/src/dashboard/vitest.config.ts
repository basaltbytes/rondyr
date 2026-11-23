import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const folder = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // The aliases of vite.config.ts that the tests of the dashboard import through.
  resolve: {
    alias: {
      "~": folder("."),
      "@rondyr/deliveries": folder("../domain/deliveries"),
    },
  },
  test: {
    name: "dashboard",
    include: ["**/*.test.ts"],
    // Dates are shown in the reader's time zone. A fixed zone with daylight saving
    // time gives the same results on every machine and covers the days of 23 and 25 hours.
    env: { TZ: "Europe/Paris" },
  },
});
