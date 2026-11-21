import { Clock, Effect, Layer, Schema } from "effect";

import {
  DeliveryCount,
  OrganizationStatus,
  OutboxStatus,
  QuarantineCount,
  StuckSubmission,
} from "../../domain/submissions/operations-status.ts";
import { OrganizationId, type UserId } from "../../domain/submissions/submission.id.ts";
import { OperationsStore } from "../../ports/operations-status.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const members = `SELECT organization_id FROM organization_members WHERE user_id = ?`;
// Each outbox event with its submission. The queries below read the events through the
// partial indexes `outbox_due_idx` and `outbox_stuck_idx`: CROSS JOIN keeps SQLite from
// reading every submission of the organization first.
const events = `outbox_events e CROSS JOIN submissions s ON s.id = e.submission_id`;
const due = `e.handed_off_at IS NULL AND e.stuck_at IS NULL`;
const stuckEvents = `e.handed_off_at IS NULL AND e.stuck_at IS NOT NULL`;
const last24hMs = 24 * 60 * 60 * 1000;
/** The stuck submissions a page lists; the count covers them all. */
const stuckListLimit = 50;

const decodeOrganizations = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: OrganizationId,
      name: Schema.String,
      receivedLast24h: OrganizationStatus.fields.receivedLast24h,
    }),
  ),
);
const decodeOutbox = Schema.decodeUnknownEffect(
  Schema.Array(OutboxStatus.mapFields((fields) => ({ ...fields, id: OrganizationId }))),
);
const decodeDeliveries = Schema.decodeUnknownEffect(
  Schema.Array(DeliveryCount.mapFields((fields) => ({ ...fields, id: OrganizationId }))),
);
const decodeQuarantines = Schema.decodeUnknownEffect(
  Schema.Array(QuarantineCount.mapFields((fields) => ({ ...fields, id: OrganizationId }))),
);
const decodeStuckCount = Schema.decodeUnknownEffect(
  Schema.Struct({ count: OutboxStatus.fields.stuck }),
);
const decodeStuck = Schema.decodeUnknownEffect(Schema.Array(StuckSubmission));

const read = Effect.fn("OperationsStore.read")(
  function* (userId: typeof UserId.Type) {
    const db = yield* database;
    const now = yield* Clock.currentTimeMillis;
    const since = now - last24hMs;
    const [organizations, outbox, deliveries, quarantines] = yield* d1(() =>
      db.batch([
        db
          .prepare(`
        SELECT o.id, o.name, (
          SELECT COUNT(*) FROM submissions s
          WHERE s.organization_id = o.id AND s.received_at >= ?
        ) AS receivedLast24h
        FROM organizations o WHERE o.id IN (${members}) ORDER BY o.name, o.id
      `)
          .bind(since, userId),
        db
          .prepare(`
        SELECT id, SUM(pending) AS count, MAX(0, ? - MIN(receivedAt)) AS oldestAgeMs,
          SUM(1 - pending) AS stuck
        FROM (
          SELECT s.organization_id AS id, 1 AS pending, s.received_at AS receivedAt
          FROM ${events} WHERE ${due} AND s.organization_id IN (${members})
          UNION ALL
          SELECT s.organization_id, 0, NULL
          FROM ${events} WHERE ${stuckEvents} AND s.organization_id IN (${members})
        )
        GROUP BY id
      `)
          .bind(now, userId, userId),
        db
          .prepare(`
        SELECT s.organization_id AS id, d.status, COUNT(*) AS count
        FROM submissions s JOIN deliveries d ON d.submission_id = s.id
        WHERE s.organization_id IN (${members}) GROUP BY s.organization_id, d.status
      `)
          .bind(userId),
        db
          .prepare(`
        SELECT s.organization_id AS id, i.reason, COUNT(*) AS count
        FROM submissions s JOIN submission_inbox i ON i.submission_id = s.id
        WHERE s.organization_id IN (${members}) AND s.received_at >= ? AND i.status = 'quarantined'
        GROUP BY s.organization_id, i.reason
      `)
          .bind(userId, since),
      ]),
    );
    const rows = yield* decodeOrganizations(organizations?.results);
    const outboxRows = yield* decodeOutbox(outbox?.results);
    const deliveryRows = yield* decodeDeliveries(deliveries?.results);
    const quarantineRows = yield* decodeQuarantines(quarantines?.results);
    const outboxById = new Map(outboxRows.map(({ id, ...counts }) => [id, counts]));
    const deliveriesById = Map.groupBy(deliveryRows, ({ id }) => id);
    const quarantinesById = Map.groupBy(quarantineRows, ({ id }) => id);
    return rows.map((organization) => ({
      ...organization,
      outbox: outboxById.get(organization.id) ?? { count: 0, oldestAgeMs: null, stuck: 0 },
      deliveries: (deliveriesById.get(organization.id) ?? []).map(({ status, count }) => ({
        status,
        count,
      })),
      quarantinedLast24h: (quarantinesById.get(organization.id) ?? []).map(({ reason, count }) => ({
        reason,
        count,
      })),
    }));
  },
  Effect.mapError(() => StorageUnavailable.make()),
);

const stuck = Effect.fn("OperationsStore.stuck")(
  function* (userId: typeof UserId.Type, organizationId: OrganizationId) {
    const db = yield* database;
    const stuckIn = `${stuckEvents}
      AND s.organization_id = ? AND s.organization_id IN (${members})`;
    const [count, rows] = yield* d1(() =>
      db.batch([
        db
          .prepare(`
        SELECT COUNT(*) AS count FROM ${events} WHERE ${stuckIn}
      `)
          .bind(organizationId, userId),
        db
          .prepare(`
        SELECT s.id AS submissionId, f.public_id AS formPublicId, f.name AS formName,
          s.received_at AS receivedAt, e.stuck_at AS stuckAt
        FROM ${events} JOIN forms f ON f.id = s.form_id
        WHERE ${stuckIn}
        ORDER BY s.received_at, s.id LIMIT ?
      `)
          .bind(organizationId, userId, stuckListLimit),
      ]),
    );
    const total = yield* decodeStuckCount(count?.results[0]);
    const submissions = yield* decodeStuck(rows?.results);
    return { count: total.count, submissions };
  },
  Effect.mapError(() => StorageUnavailable.make()),
);

export const operationsStoreLive = Layer.succeed(OperationsStore, { read, stuck });
