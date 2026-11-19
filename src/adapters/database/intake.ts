import { Clock, Effect, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { SubmissionFields } from "../../domain/submissions/submission-fields.ts";
import { SubmissionId } from "../../domain/submissions/submission.id.ts";
import { d1, database } from "./d1.ts";

export class FormNotFound extends Schema.TaggedError<
  FormNotFound,
  { readonly brand: unique symbol }
>()("FormNotFound", {}) {}
export class FormRateLimited extends Schema.TaggedError<
  FormRateLimited,
  { readonly brand: unique symbol }
>()("FormRateLimited", {}) {}

const encodeFields = Schema.encodeEffect(Schema.fromJsonString(SubmissionFields));

export const receiveSubmission = Effect.fn("Intake.receive")(function* (
  publicId: string,
  fields: typeof SubmissionFields.Type,
) {
  const db = yield* database;
  const id = SubmissionId.make(SecureRandom.uuidV4Unsafe());
  const now = yield* Clock.currentTimeMillis;
  const encoded = yield* encodeFields(fields).pipe(Effect.orDie);
  const insert = db
    .prepare(`
    INSERT INTO submissions (id, organization_id, form_id, fields, received_at)
    SELECT ?, forms.organization_id, forms.id, ?, ?
    FROM forms
    WHERE public_id = ?
      AND (SELECT COUNT(*) FROM submissions WHERE form_id = forms.id AND received_at > ?) < 30
  `)
    .bind(id, encoded, now, publicId, now - 60_000);
  const outbox = db
    .prepare(`
    INSERT INTO outbox_events (submission_id)
    SELECT id FROM submissions WHERE id = ?
  `)
    .bind(id);
  const [received] = yield* d1(() => db.batch([insert, outbox]));
  if (received?.meta.changes === 1) return id;

  const exists = yield* d1(() =>
    db.prepare("SELECT 1 FROM forms WHERE public_id = ?").bind(publicId).first(),
  );
  if (exists === null) return yield* FormNotFound.make();
  return yield* FormRateLimited.make();
});
