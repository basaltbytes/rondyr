import { Clock, Effect, Layer, Option, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";
import {
  FormNotFound,
  FormRateLimited,
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
});
const decodeAccess = Schema.decodeUnknownEffect(Schema.Array(AccessRow));

// One row for a known form, none for an unknown one. ?1 is the public ID and
// ?2 the request's origin, or NULL.
const accessQuery = `
  SELECT
    EXISTS (SELECT 1 FROM form_origins o WHERE o.form_id = f.id) AS restricted,
    EXISTS (SELECT 1 FROM form_origins o WHERE o.form_id = f.id AND o.origin = ?2) AS listed
  FROM forms f
  WHERE f.public_id = ?1
`;

const originMatch = (row: typeof AccessRow.Type): OriginMatch => {
  if (row.restricted === 0) return "unrestricted";
  return row.listed === 1 ? "listed" : "unlisted";
};

const readAccess = (rows: ReadonlyArray<unknown> | undefined) =>
  decodeAccess(rows ?? []).pipe(
    Effect.mapBoth({
      onFailure: () => StorageUnavailable.make(),
      onSuccess: (decoded) => Option.map(Option.fromNullishOr(decoded[0]), originMatch),
    }),
  );

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
  const access = db.prepare(accessQuery).bind(publicId, requestOrigin);
  const insert = db
    .prepare(`
    INSERT INTO submissions (id, organization_id, form_id, fields, received_at)
    SELECT ?1, forms.organization_id, forms.id, ?2, ?3
    FROM forms
    WHERE public_id = ?4
      AND (
        ?6 IS NULL
        OR NOT EXISTS (SELECT 1 FROM form_origins WHERE form_id = forms.id)
        OR EXISTS (SELECT 1 FROM form_origins WHERE form_id = forms.id AND origin = ?6)
      )
      AND (SELECT COUNT(*) FROM submissions WHERE form_id = forms.id AND received_at > ?5) < 30
  `)
    .bind(id, encoded, now, publicId, now - 60_000, requestOrigin);
  const outbox = db
    .prepare(`
    INSERT INTO outbox_events (submission_id)
    SELECT id FROM submissions WHERE id = ?
  `)
    .bind(id);
  const [accessResult, received] = yield* d1(() => db.batch([access, insert, outbox]));
  const match = yield* readAccess(accessResult?.results);
  if (Option.isNone(match)) return yield* FormNotFound.make();
  if (received?.meta.changes === 1) return { submissionId: id, origins: match.value };
  if (match.value === "unlisted" && requestOrigin !== null) return yield* OriginRefused.make();
  return yield* FormRateLimited.make({ origins: match.value });
});

const matchOrigin = Effect.fn("Intake.matchOrigin")(function* (
  publicId: string,
  origin: Option.Option<string>,
) {
  const db = yield* database;
  const found = yield* d1(() =>
    db.prepare(accessQuery).bind(publicId, Option.getOrNull(origin)).all(),
  );
  const match = yield* readAccess(found.results);
  if (Option.isNone(match)) return yield* FormNotFound.make();
  return match.value;
});

export const submissionIntakeLive = Layer.succeed(SubmissionIntake, { receive, matchOrigin });
