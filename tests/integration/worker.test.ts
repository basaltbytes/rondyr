import { applyD1Migrations } from "cloudflare:test";
import { env, exports as worker } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { Effect, Exit } from "effect";
import { assert, describe, it } from "@effect/vitest";

import { forms, organizations } from "../../src/adapters/database/database-schema.ts";

describe("Rondyr Worker", () => {
  it.effect("answers the public health check without caching it", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        worker.default.fetch("https://rondyr.test/health"),
      );
      const body = yield* Effect.promise(() => response.json());

      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(body, { status: "ok" });
    }),
  );

  it.effect("returns 404 for a missing API route", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        worker.default.fetch("https://rondyr.test/api/missing"),
      );

      assert.strictEqual(response.status, 404);
    }),
  );

  it.effect("applies the committed migration and writes a form in D1 with Drizzle", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
      const db = drizzle(env.DB);

      yield* Effect.promise(() =>
        db.insert(organizations).values({ id: "test-org", name: "Test organization" }).run(),
      );
      yield* Effect.promise(() =>
        db
          .insert(forms)
          .values({
            id: "test-form",
            organizationId: "test-org",
            publicId: "contact",
            name: "Contact",
          })
          .run(),
      );
      const rows = yield* Effect.promise(() => db.select().from(forms).all());

      assert.deepEqual(rows, [
        { id: "test-form", organizationId: "test-org", publicId: "contact", name: "Contact" },
      ]);

      const missingId = yield* Effect.exit(
        Effect.promise(() =>
          env.DB.prepare("INSERT INTO organizations (name) VALUES (?)").bind("Missing ID").run(),
        ),
      );
      assert.isTrue(Exit.isFailure(missingId));
    }),
  );
});
