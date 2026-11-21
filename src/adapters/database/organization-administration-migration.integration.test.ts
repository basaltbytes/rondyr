import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

// This file has its own storage, so this database starts empty here.
const db = env.CLOUDFLARE_EMAIL_DB;

it.effect(
  "makes existing members admins and confirms the recipients of existing email destinations",
  () =>
    Effect.gen(function* () {
      const migrations = env.TEST_MIGRATIONS;
      const index = migrations.findIndex(({ name }) =>
        name.includes("_organization-administration"),
      );
      assert.isAbove(index, 0);
      yield* Effect.promise(() => applyD1Migrations(db, migrations.slice(0, index)));
      yield* Effect.promise(() =>
        db.batch([
          db.prepare(
            "INSERT INTO auth_users (id, name, email, created_at, updated_at) VALUES ('owner', 'Owner', 'owner@example.test', 0, 0)",
          ),
          db.prepare(
            "INSERT INTO organizations (id, name) VALUES ('studio', 'Studio'), ('other', 'Other')",
          ),
          db.prepare(
            "INSERT INTO organization_members (organization_id, user_id) VALUES ('studio', 'owner')",
          ),
          db.prepare(
            "INSERT INTO forms (id, organization_id, public_id, name) VALUES ('form', 'studio', 'contact', 'Contact'), ('form-2', 'other', 'other', 'Other')",
          ),
          db.prepare(`
          INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at) VALUES
            ('mail', 'studio', 'form', 'email', '{"recipients":["Team@Example.test","owner@example.test"],"language":"fr"}', 0),
            ('mail-2', 'studio', 'form', 'email', '{"recipients":["team@example.test"]}', 0),
            ('hook', 'studio', 'form', 'webhook', '{"url":"https://hooks.example.com/a","secret":"v1.a.b","previousSecret":null}', 0),
            ('mail-3', 'other', 'form-2', 'email', '{"recipients":["team@example.test"]}', 0)
        `),
        ]),
      );

      yield* Effect.promise(() => applyD1Migrations(db, migrations));
      // During a deployment, the Worker before roles still runs after the migration:
      // the organization that it creates gets its creator as an admin.
      yield* Effect.promise(() =>
        db.batch([
          db.prepare("INSERT INTO organizations (id, name) VALUES ('created-meanwhile', 'Late')"),
          db.prepare(
            "INSERT INTO organization_members (organization_id, user_id) VALUES ('created-meanwhile', 'owner')",
          ),
        ]),
      );

      const role = yield* Effect.promise(() =>
        db
          .prepare(
            "SELECT role FROM organization_members WHERE user_id = 'owner' AND organization_id = 'studio'",
          )
          .first("role"),
      );
      const meanwhile = yield* Effect.promise(() =>
        db
          .prepare(
            "SELECT role FROM organization_members WHERE organization_id = 'created-meanwhile'",
          )
          .first("role"),
      );
      const confirmed = yield* Effect.promise(() =>
        db
          .prepare(
            "SELECT organization_id, address, confirmed_at IS NOT NULL AS confirmed FROM email_recipient_confirmations ORDER BY organization_id, address",
          )
          .all(),
      );
      const retention = yield* Effect.promise(() =>
        db
          .prepare(
            "SELECT accepted_retention_days, quarantine_retention_days FROM organizations WHERE id = 'studio'",
          )
          .first(),
      );

      assert.strictEqual(role, "admin");
      assert.strictEqual(meanwhile, "admin");
      assert.deepEqual(confirmed.results, [
        { organization_id: "other", address: "team@example.test", confirmed: 1 },
        { organization_id: "studio", address: "owner@example.test", confirmed: 1 },
        { organization_id: "studio", address: "team@example.test", confirmed: 1 },
      ]);
      assert.deepEqual(retention, {
        accepted_retention_days: null,
        quarantine_retention_days: null,
      });
    }),
);
