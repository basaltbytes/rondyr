import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/worker/adapters/database/*-schema.ts",
  out: "./database/migrations",
});
