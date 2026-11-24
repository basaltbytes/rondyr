import { Effect, Layer, Schema } from "effect";

import { DailyUsage, type DailyQuotas } from "../../../domain/organizations/organization-quotas.ts";
import type { OrganizationId } from "../../../domain/submissions/submission.id.ts";
import type { OrganizationScope } from "../../ports/organization-directory.ts";
import { OrganizationQuotas, OrganizationQuotasNotFound } from "../../ports/organization-quotas.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const decodeUsage = Schema.decodeUnknownEffect(
  Schema.Struct({
    day: DailyUsage.fields.day,
    limits: Schema.fromJsonString(DailyUsage.fields.limits),
    used: Schema.fromJsonString(DailyUsage.fields.used),
  }),
);

const member =
  "SELECT 1 FROM organization_members WHERE user_id = ?1 AND organization_id = ?2 AND role = 'admin'";
const usageQuery = `
  SELECT date('now') AS day,
    json_object('submissions', o.daily_submission_limit,
      'classifications', o.daily_classification_limit) AS limits,
    json_object('submissions', COALESCE(u.submissions, 0),
      'classifications', COALESCE(u.classifications, 0), 'junk', COALESCE(u.junk, 0)) AS used
  FROM organizations o
  LEFT JOIN organization_daily_usage u ON u.organization_id = o.id AND u.day = date('now')
  WHERE o.id = ?2 AND EXISTS (${member})
`;

const usage = Effect.fn("OrganizationQuotas.usage")(function* (scope: OrganizationScope) {
  const db = yield* database;
  const row = yield* d1(() =>
    db.prepare(usageQuery).bind(scope.userId, scope.organizationId).first(),
  );
  if (row === null) return yield* OrganizationQuotasNotFound.make();
  return yield* decodeUsage(row).pipe(Effect.mapError(() => StorageUnavailable.make()));
});

const save = Effect.fn("OrganizationQuotas.save")(function* (
  scope: OrganizationScope,
  limits: DailyQuotas,
) {
  const db = yield* database;
  const key = [scope.userId, scope.organizationId] as const;
  const [, updated] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
      UPDATE organizations SET daily_submission_limit = ?3, daily_classification_limit = ?4
      WHERE id = ?2 AND EXISTS (${member})
    `)
        .bind(...key, limits.submissions, limits.classifications),
      db.prepare(usageQuery).bind(...key),
    ]),
  );
  const row = updated?.results[0];
  if (row === undefined) return yield* OrganizationQuotasNotFound.make();
  return yield* decodeUsage(row).pipe(Effect.mapError(() => StorageUnavailable.make()));
});

// The check and the increment are one statement, so concurrent reservations
// cannot both take the last place. A counter row of another day starts over,
// as in the intake batch.
const reserveStatement = `
  INSERT INTO organization_daily_usage (organization_id, day, submissions, classifications)
  SELECT o.id, date('now'), 0, 1
  FROM organizations o
  LEFT JOIN organization_daily_usage u ON u.organization_id = o.id AND u.day = date('now')
  WHERE o.id = ?1 AND COALESCE(u.classifications, 0) < o.daily_classification_limit
  ON CONFLICT (organization_id) DO UPDATE SET
    submissions = CASE WHEN day = excluded.day THEN submissions ELSE 0 END,
    classifications = 1 + CASE WHEN day = excluded.day THEN classifications ELSE 0 END,
    junk = CASE WHEN day = excluded.day THEN junk ELSE 0 END,
    day = excluded.day
  RETURNING classifications
`;
const decodeReserved = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ classifications: Schema.Int })),
);

const reserveClassification = Effect.fn("OrganizationQuotas.reserveClassification")(function* (
  organizationId: OrganizationId,
) {
  const db = yield* database;
  const { results } = yield* d1(() => db.prepare(reserveStatement).bind(organizationId).all());
  const reserved = yield* decodeReserved(results).pipe(
    Effect.mapError(() => StorageUnavailable.make()),
  );
  return reserved.length === 1 ? ("reserved" as const) : ("limit-reached" as const);
});

// A reservation of an earlier day is not given back: that day's counter is gone.
const releaseStatement = `
  UPDATE organization_daily_usage SET classifications = classifications - 1
  WHERE organization_id = ?1 AND day = date('now') AND classifications > 0
`;

const releaseClassification = Effect.fn("OrganizationQuotas.releaseClassification")(function* (
  organizationId: OrganizationId,
) {
  const db = yield* database;
  yield* d1(() => db.prepare(releaseStatement).bind(organizationId).run());
});

export const organizationQuotasLive = Layer.succeed(OrganizationQuotas, {
  usage,
  save,
  reserveClassification,
  releaseClassification,
});
