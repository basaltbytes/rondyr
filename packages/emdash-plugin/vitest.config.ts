import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "emdash-plugin",
    include: ["src/**/*.test.ts"],
  },
});
