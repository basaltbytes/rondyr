import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/adapters/database/database-schema.ts",
  out: "./database/migrations",
});
