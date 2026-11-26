import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { assert, beforeAll, it } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";

import { testOrigin as origin } from "../../../tests/integration/auth-fixture.ts";
import { setupOwner } from "../../../tests/integration/organization-fixture.ts";
import { OperationsStatus } from "../../domain/submissions/operations-status.ts";
import { OrganizationId } from "../../domain/submissions/submission.id.ts";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownEffect(OperationsStatus);

beforeAll(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

it.live(
  "reports only member organizations, with current queue totals and the 24-hour intake cohort",
  () =>
    Effect.gen(function* () {
      const denied = yield* Effect.promise(() => env.TEST_WORKER.fetch(`${origin}/api/operations`));
      assert.strictEqual(denied.status, 401);

      const { cookie } = yield* setupOwner({ name: "Operator", email: "operations@example.test" });
      const read = () =>
        Effect.promise(() =>
          env.TEST_WORKER.fetch(`${origin}/api/operations`, { headers: { cookie } }),
        );
      const beforeSetup = yield* read();
      assert.strictEqual(beforeSetup.status, 200);
      const initial = yield* Effect.promise(() => beforeSetup.json());
      assert.deepEqual(initial, {
        organizations: [],
        lastSuccessfulCronAt: null,
      });

      const now = yield* Clock.currentTimeMillis;
      const marker = "operations-private-fields-864e24";
      const fields = yield* encode({ message: marker });
      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare(
            `INSERT INTO organizations (id, name) VALUES ('studio', 'Atelier'), ('empty', 'Vide'), ('hidden', 'Autre')`,
          ),
          env.DB.prepare(`INSERT INTO organization_members (organization_id, user_id, role)
        SELECT o.id, u.id, 'admin' FROM auth_users u CROSS JOIN organizations o WHERE o.id IN ('studio', 'empty')`),
          env.DB.prepare(`INSERT INTO forms (id, organization_id, public_id, name)
        VALUES ('studio-form', 'studio', 'studio-public', 'Atelier'), ('hidden-form', 'hidden', 'hidden-public', 'Autre')`),
          env.DB.prepare(`INSERT INTO submissions (id, organization_id, form_id, fields, received_at) VALUES
        ('old-event', 'studio', 'studio-form', ?1, ?2),
        ('recent-1', 'studio', 'studio-form', ?1, ?3),
        ('recent-2', 'studio', 'studio-form', ?1, ?3),
        ('recent-3', 'studio', 'studio-form', ?1, ?3),
        ('recent-4', 'studio', 'studio-form', ?1, ?3),
        ('reviewed', 'studio', 'studio-form', ?1, ?3),
        ('other-event', 'hidden', 'hidden-form', ?1, ?2)
      `).bind(fields, now - 25 * 60 * 60 * 1000, now - 10 * 60 * 1000),
          env.DB.prepare(`INSERT INTO outbox_events (submission_id, published_at, handed_off_at) VALUES
        ('old-event', NULL, NULL), ('recent-1', ?1, NULL), ('recent-2', ?1, ?1), ('other-event', NULL, NULL)
      `).bind(now),
          env.DB
            .prepare(`INSERT INTO submission_inbox (submission_id, version, status, reason) VALUES
        ('old-event', 2, 'quarantined', 'ambiguous'), ('recent-1', 2, 'quarantined', 'honeypot'),
        ('recent-2', 2, 'quarantined', 'ambiguous'), ('recent-3', 2, 'quarantined', 'ambiguous'),
        ('recent-4', 2, 'quarantined', 'repetition'),
        ('reviewed', 3, 'archived', NULL), ('other-event', 2, 'quarantined', 'honeypot')`),
          env.DB
            .prepare(`INSERT INTO notification_targets (id, organization_id, form_id, type, configuration, created_at) VALUES
        ('studio-target', 'studio', 'studio-form', 'webhook', '{}', 0),
        ('hidden-target', 'hidden', 'hidden-form', 'webhook', '{}', 0)`),
          env.DB
            .prepare(`INSERT INTO deliveries (id, submission_id, target_id, status, next_attempt_at, created_at, updated_at) VALUES
        ('delivery-1', 'old-event', 'studio-target', 'delivered', 0, 0, 0),
        ('delivery-2', 'reviewed', 'studio-target', 'retrying', 0, 0, 0),
        ('delivery-3', 'other-event', 'hidden-target', 'failed', 0, 0, 0)`),
        ]),
      );

      const response = yield* read();
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("cache-control"), "no-store");
      const body = yield* Effect.promise(() => response.clone().text());
      assert.notInclude(body, marker);
      assert.notInclude(body, '"fields"');
      assert.notInclude(body, '"hidden"');
      const raw = yield* Effect.promise(() => response.json());
      const snapshot = yield* decode(raw);
      const [studio, empty] = snapshot.organizations;
      assert.isDefined(studio);
      assert.isDefined(empty);
      assert.lengthOf(snapshot.organizations, 2);
      assert.strictEqual(studio.id, "studio");
      assert.strictEqual(studio.outbox.count, 2);
      assert.isAtLeast(studio.outbox.oldestAgeMs ?? 0, 25 * 60 * 60 * 1000);
      assert.strictEqual(studio.receivedLast24h, 5);
      assert.sameDeepMembers(
        [...studio.deliveries],
        [
          { status: "delivered", count: 1 },
          { status: "retrying", count: 1 },
        ],
      );
      assert.sameDeepMembers(
        [...studio.quarantinedLast24h],
        [
          { reason: "ambiguous", count: 2 },
          { reason: "honeypot", count: 1 },
          { reason: "repetition", count: 1 },
        ],
      );
      assert.deepEqual(empty, {
        id: OrganizationId.make("empty"),
        name: "Vide",
        outbox: { count: 0, oldestAgeMs: null, stuck: 0 },
        deliveries: [],
        receivedLast24h: 0,
        quarantinedLast24h: [],
      });
    }),
);
