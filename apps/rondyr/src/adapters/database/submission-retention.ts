import { Clock, Effect, Layer, Schema } from "effect";

import { dayMillis, RetentionPeriods } from "../../domain/organizations/retention.ts";
import { SubmissionNotFound } from "../../domain/submissions/submission.rejection.ts";
import { OrganizationId, SubmissionId } from "../../domain/submissions/submission.id.ts";
import type { OrganizationScope } from "../../ports/organization-directory.ts";
import { SubmissionRetention, type RetentionLane } from "../../ports/submission-retention.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const unreadable = () => StorageUnavailable.make();
const decodePeriods = Schema.decodeUnknownEffect(RetentionPeriods);
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: SubmissionId })));

// The statuses of each lane, and the period of the organization that covers them.
// A message still received or being classified has no inbox status here and is kept.
const laneCondition = {
  accepted: `
    i.status = 'accepted' AND o.accepted_retention_days IS NOT NULL
    AND s.received_at <= ?3 - o.accepted_retention_days * ${dayMillis}
  `,
  quarantine: `
    i.status IN ('quarantined', 'archived') AND o.quarantine_retention_days IS NOT NULL
    AND s.received_at <= ?3 - o.quarantine_retention_days * ${dayMillis}
  `,
} as const;

const decodeLanes = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      organizationId: OrganizationId,
      accepted: RetentionPeriods.fields.accepted,
      quarantine: RetentionPeriods.fields.quarantine,
    }),
  ),
);

const remove = Effect.fn("SubmissionRetention.remove")(function* (
  scope: OrganizationScope,
  submissionId: SubmissionId,
) {
  const db = yield* database;
  const now = yield* Clock.currentTimeMillis;
  // ?1 account, ?2 organization, ?3 submission, ?4 time.
  const member = "SELECT 1 FROM organization_members WHERE user_id = ?1 AND organization_id = ?2";
  const [, deleted] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        INSERT INTO submission_deletions (submission_id, organization_id, deleted_at, deleted_by, cause)
        SELECT id, organization_id, ?4, ?1, 'request' FROM submissions
        WHERE id = ?3 AND organization_id = ?2 AND EXISTS (${member})
      `)
        .bind(scope.userId, scope.organizationId, submissionId, now),
      db
        .prepare(`
        DELETE FROM submissions WHERE id = ?3 AND organization_id = ?2 AND EXISTS (${member})
        RETURNING id
      `)
        .bind(scope.userId, scope.organizationId, submissionId),
    ]),
  );
  const rows = yield* decodeIds(deleted?.results).pipe(Effect.mapError(unreadable));
  if (rows.length === 0) return yield* SubmissionNotFound.make();
});

const columns = "accepted_retention_days AS accepted, quarantine_retention_days AS quarantine";

const periods = Effect.fn("SubmissionRetention.periods")(function* (scope: OrganizationScope) {
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare(`SELECT ${columns} FROM organizations WHERE id = ?`)
      .bind(scope.organizationId)
      .first(),
  );
  return yield* decodePeriods(row).pipe(Effect.mapError(unreadable));
});

const savePeriods = Effect.fn("SubmissionRetention.savePeriods")(function* (
  scope: OrganizationScope,
  { accepted, quarantine }: RetentionPeriods,
) {
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare(`
      UPDATE organizations SET accepted_retention_days = ?2, quarantine_retention_days = ?3
      WHERE id = ?1 RETURNING ${columns}
    `)
      .bind(scope.organizationId, accepted, quarantine)
      .first(),
  );
  return yield* decodePeriods(row).pipe(Effect.mapError(unreadable));
});

const retentionLanes = Effect.fn("SubmissionRetention.retentionLanes")(function* (now: number) {
  const db = yield* database;
  const rows = yield* d1(() =>
    db
      .prepare(`
      SELECT id AS organizationId, ${columns} FROM organizations
      WHERE accepted_retention_days IS NOT NULL OR quarantine_retention_days IS NOT NULL
      ORDER BY id
    `)
      .all(),
  );
  const organizations = yield* decodeLanes(rows.results).pipe(Effect.mapError(unreadable));
  return organizations.flatMap(({ organizationId, accepted, quarantine }) => [
    ...(accepted === null
      ? []
      : [{ organizationId, statuses: "accepted" as const, cutoff: now - accepted * dayMillis }]),
    ...(quarantine === null
      ? []
      : [
          {
            organizationId,
            statuses: "quarantine" as const,
            cutoff: now - quarantine * dayMillis,
          },
        ]),
  ]);
});

const purgeLane = Effect.fn("SubmissionRetention.purgeLane")(function* (
  lane: RetentionLane,
  now: number,
  limit: number,
) {
  const db = yield* database;
  // ?1 organization, ?2 the cutoff of the lane, ?3 the time, ?4 the size of the batch.
  // The cutoff bounds the read to the organization's messages received before
  // it, in the order of its index; the condition of the lane reads the period
  // again. One transaction logs the batch, then deletes the messages it logged.
  const [, deleted] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        INSERT INTO submission_deletions (submission_id, organization_id, deleted_at, deleted_by, cause)
        SELECT s.id, s.organization_id, ?3, NULL, 'retention'
        FROM organizations o
          JOIN submissions s ON s.organization_id = o.id
          JOIN submission_inbox i ON i.submission_id = s.id
        WHERE o.id = ?1 AND s.received_at <= ?2 AND ${laneCondition[lane.statuses]}
        ORDER BY s.received_at, s.id LIMIT ?4
      `)
        .bind(lane.organizationId, lane.cutoff, now, limit),
      db
        .prepare(`
        DELETE FROM submissions WHERE id IN (
          SELECT submission_id FROM submission_deletions
          WHERE organization_id = ?1 AND deleted_at = ?2 AND cause = 'retention'
        )
        RETURNING id
      `)
        .bind(lane.organizationId, now),
    ]),
  );
  const rows = yield* decodeIds(deleted?.results).pipe(Effect.mapError(unreadable));
  return rows.length;
});

export const submissionRetentionLive = Layer.succeed(SubmissionRetention, {
  remove,
  periods,
  savePeriods,
  retentionLanes,
  purgeLane,
});
