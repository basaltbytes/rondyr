import { Clock, Effect, Layer, Schema } from "effect";

import {
  DeliveryCount,
  OrganizationStatus,
  OutboxStatus,
  QuarantineCount,
} from "../../domain/submissions/operations-status.ts";
import { OrganizationId, type UserId } from "../../domain/submissions/submission.id.ts";
import { OperationsStore } from "../../ports/operations-status.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const members = `SELECT organization_id FROM organization_members WHERE user_id = ?`;
const last24hMs = 24 * 60 * 60 * 1000;

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
        SELECT s.organization_id AS id, COUNT(*) AS count,
          MAX(0, ? - MIN(s.received_at)) AS oldestAgeMs
        FROM outbox_events e JOIN submissions s ON s.id = e.submission_id
        WHERE e.handed_off_at IS NULL AND s.organization_id IN (${members})
        GROUP BY s.organization_id
      `)
          .bind(now, userId),
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
      outbox: outboxById.get(organization.id) ?? { count: 0, oldestAgeMs: null },
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

export const operationsStoreLive = Layer.succeed(OperationsStore, { read });
