import { Effect, Layer, Schema } from "effect";

import { dayMillis, RetentionPeriods } from "../../domain/organizations/retention.ts";
import { SubmissionNotFound } from "../../domain/submissions/submission.rejection.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";
import type { OrganizationScope } from "../../ports/organization-directory.ts";
import { SubmissionRetention } from "../../ports/submission-retention.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { Clock } from "effect";
import { d1, database } from "./d1.ts";

const unreadable = () => StorageUnavailable.make();
const decodePeriods = Schema.decodeUnknownEffect(RetentionPeriods);
const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: SubmissionId })));
const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(SubmissionId)));

// ?1 is the time in milliseconds. A message is expired once its age reaches the
// period of its status: `received_at` at the exact boundary is purged. A message
// still received or being classified has no inbox status here and is kept.
const expired = `
  (
    (i.status = 'accepted' AND o.accepted_retention_days IS NOT NULL
      AND s.received_at <= ?1 - o.accepted_retention_days * ${dayMillis})
    OR (i.status IN ('quarantined', 'archived') AND o.quarantine_retention_days IS NOT NULL
      AND s.received_at <= ?1 - o.quarantine_retention_days * ${dayMillis})
  )
`;
const expiredTables = `
  FROM organizations o
    JOIN submissions s ON s.organization_id = o.id
    JOIN submission_inbox i ON i.submission_id = s.id
`;

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

const purgeExpired = Effect.fn("SubmissionRetention.purgeExpired")(function* (
  now: number,
  limit: number,
) {
  const db = yield* database;
  const candidates = yield* d1(() =>
    db
      .prepare(`
      SELECT s.id ${expiredTables}
      WHERE (o.accepted_retention_days IS NOT NULL OR o.quarantine_retention_days IS NOT NULL)
        AND ${expired}
      ORDER BY s.received_at, s.id LIMIT ?2
    `)
      .bind(now, limit)
      .all(),
  );
  const ids = yield* decodeIds(candidates.results).pipe(Effect.mapError(unreadable));
  if (ids.length === 0) return 0;
  const list = yield* encodeIds(ids.map(({ id }) => id)).pipe(Effect.mapError(unreadable));
  // One transaction logs and deletes the batch. Each statement checks the period
  // again, so a message that a change made current again stays.
  const [, deleted] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        INSERT INTO submission_deletions (submission_id, organization_id, deleted_at, deleted_by, cause)
        SELECT s.id, s.organization_id, ?1, NULL, 'retention' ${expiredTables}
        WHERE s.id IN (SELECT value FROM json_each(?2)) AND ${expired}
      `)
        .bind(now, list),
      db
        .prepare(`
        DELETE FROM submissions WHERE id IN (
          SELECT d.submission_id FROM submission_deletions d
          WHERE d.submission_id IN (SELECT value FROM json_each(?2))
            AND d.cause = 'retention' AND d.deleted_at = ?1
        )
        RETURNING id
      `)
        .bind(now, list),
    ]),
  );
  const rows = yield* decodeIds(deleted?.results).pipe(Effect.mapError(unreadable));
  return rows.length;
});

export const submissionRetentionLive = Layer.succeed(SubmissionRetention, {
  remove,
  periods,
  savePeriods,
  purgeExpired,
});
