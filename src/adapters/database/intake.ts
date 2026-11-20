import { Clock, Effect, Layer, Option, Result, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { parseSuccessUrl } from "../../domain/forms/form.ts";
import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";
import {
  EmptySubmission,
  FormNotFound,
  FormRateLimited,
  FormSuspended,
  OriginRefused,
  SubmissionIntake,
  type OriginMatch,
} from "../../ports/intake.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const encodeFields = Schema.encodeEffect(Schema.fromJsonString(SubmissionFields));
const AccessRow = Schema.Struct({
  restricted: Schema.Literals([0, 1]),
  listed: Schema.Literals([0, 1]),
  active: Schema.Literals([0, 1]),
  success_url: Schema.NullOr(Schema.String),
  honeypot_field: Schema.NullOr(Schema.String),
});
const decodeAccess = Schema.decodeUnknownEffect(Schema.Array(AccessRow));

// One row for a known form, none for an unknown one. ?1 is the public ID and
// ?2 the request's origin, or NULL. The success URL is read only while its
// origin, the URL up to its first slash after the host, is an allowed origin.
const accessQuery = `
  SELECT
    EXISTS (SELECT 1 FROM form_origins o WHERE o.form_id = f.id) AS restricted,
    EXISTS (SELECT 1 FROM form_origins o WHERE o.form_id = f.id AND o.origin = ?2) AS listed,
    f.status = 'active' AS active,
    CASE WHEN EXISTS (
      SELECT 1 FROM form_origins o
      WHERE o.form_id = f.id AND substr(f.success_url, 1, length(o.origin) + 1) = o.origin || '/'
    ) THEN f.success_url END AS success_url,
    f.honeypot_field AS honeypot_field
  FROM forms f
  WHERE f.public_id = ?1
`;

// The insert of a submission. ?1 is its ID, ?2 its fields as a JSON object, ?3
// the reception time, ?4 the form's public ID, ?5 the start of the rate window
// and ?6 the request's origin, or NULL.
//
// The honeypot rule runs here, so that one D1 round trip stores a submission:
// an empty honeypot field is removed from the stored object, keeping the order
// of the other fields, and a filled one sets the intake reason `honeypot`. A
// submission whose only field is an empty honeypot field is not stored.
const insertStatement = `
  INSERT INTO submissions (id, organization_id, form_id, fields, received_at, intake_reason)
  SELECT
    ?1,
    f.organization_id,
    f.id,
    CASE
      WHEN EXISTS (SELECT 1 FROM json_each(?2) WHERE key = f.honeypot_field AND value = '')
      THEN (
        SELECT json_group_object(key, value)
        FROM (SELECT key, value FROM json_each(?2) WHERE key <> f.honeypot_field ORDER BY id)
      )
      ELSE ?2
    END,
    ?3,
    CASE
      WHEN EXISTS (SELECT 1 FROM json_each(?2) WHERE key = f.honeypot_field AND value <> '')
      THEN 'honeypot'
    END
  FROM forms f
  WHERE f.public_id = ?4
    AND f.status = 'active'
    AND (
      ?6 IS NULL
      OR NOT EXISTS (SELECT 1 FROM form_origins WHERE form_id = f.id)
      OR EXISTS (SELECT 1 FROM form_origins WHERE form_id = f.id AND origin = ?6)
    )
    AND (
      f.honeypot_field IS NULL
      OR EXISTS (SELECT 1 FROM json_each(?2) WHERE key <> f.honeypot_field OR value <> '')
    )
    AND (SELECT COUNT(*) FROM submissions WHERE form_id = f.id AND received_at > ?5) < 30
`;

const originMatch = (row: typeof AccessRow.Type): OriginMatch => {
  if (row.restricted === 0) return "unrestricted";
  return row.listed === 1 ? "listed" : "unlisted";
};

const readAccess = (rows: ReadonlyArray<unknown> | undefined) =>
  decodeAccess(rows ?? []).pipe(
    Effect.mapBoth({
      onFailure: () => StorageUnavailable.make(),
      onSuccess: (decoded) =>
        Option.map(Option.fromNullishOr(decoded[0]), (row) => ({
          origins: originMatch(row),
          active: row.active === 1,
          // The admin API stores only URLs that pass this rule; a row edited by hand may not.
          successUrl: Option.flatMap(Option.fromNullOr(row.success_url), (url) =>
            Result.getSuccess(parseSuccessUrl(url)),
          ),
          honeypotField: Option.fromNullOr(row.honeypot_field),
        })),
    }),
  );

/** Whether the only field of a submission is the form's honeypot field, left empty. */
const onlyEmptyHoneypot = (fields: typeof SubmissionFields.Type, honeypot: Option.Option<string>) =>
  Option.exists(honeypot, (name) => {
    const names = Object.keys(fields);
    return names.length === 1 && names[0] === name && fields[name] === "";
  });

const receive = Effect.fn("Intake.receive")(function* (
  publicId: string,
  fields: typeof SubmissionFields.Type,
  origin: Option.Option<string>,
) {
  const db = yield* database;
  const id = SubmissionId.make(SecureRandom.uuidV4Unsafe());
  const now = yield* Clock.currentTimeMillis;
  const encoded = yield* encodeFields(fields).pipe(Effect.orDie);
  const requestOrigin = Option.getOrNull(origin);
  // The batch is one transaction, so the access row describes the list that the insert checked.
  const accessCheck = db.prepare(accessQuery).bind(publicId, requestOrigin);
  const insert = db
    .prepare(insertStatement)
    .bind(id, encoded, now, publicId, now - 60_000, requestOrigin);
  const outbox = db
    .prepare(`
    INSERT INTO outbox_events (submission_id)
    SELECT id FROM submissions WHERE id = ?
  `)
    .bind(id);
  const [accessResult, received] = yield* d1(() => db.batch([accessCheck, insert, outbox]));
  const access = yield* readAccess(accessResult?.results);
  if (Option.isNone(access)) return yield* FormNotFound.make();
  const { origins, active, successUrl, honeypotField } = access.value;
  if (received?.meta.changes === 1) return { submissionId: id, origins, successUrl };
  if (origins === "unlisted" && requestOrigin !== null) return yield* OriginRefused.make();
  if (!active) return yield* FormSuspended.make({ origins });
  if (onlyEmptyHoneypot(fields, honeypotField)) return yield* EmptySubmission.make({ origins });
  return yield* FormRateLimited.make({ origins });
});

const matchOrigin = Effect.fn("Intake.matchOrigin")(function* (
  publicId: string,
  origin: Option.Option<string>,
) {
  const db = yield* database;
  const found = yield* d1(() =>
    db.prepare(accessQuery).bind(publicId, Option.getOrNull(origin)).all(),
  );
  const access = yield* readAccess(found.results);
  if (Option.isNone(access)) return yield* FormNotFound.make();
  return access.value.origins;
});

export const submissionIntakeLive = Layer.succeed(SubmissionIntake, { receive, matchOrigin });
