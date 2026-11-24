import { Clock, Effect, Layer, Schema } from "effect";

import { FormOrigin, type AllowedOrigin } from "../../../domain/forms/allowed-origin.ts";
import { FormOriginNotFound, FormOrigins, OriginInUse } from "../../ports/form-origins.ts";
import type { FormScope } from "../../ports/notification-targets.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const OriginRow = Schema.Struct({ origin: Schema.String, created_at: Schema.Int });
const FormRow = Schema.Struct({ id: Schema.String });

const decodeOrigins = Schema.decodeUnknownEffect(Schema.Array(OriginRow));
const decodeForms = Schema.decodeUnknownEffect(Schema.Array(FormRow));

const unreadable = () => StorageUnavailable.make();

const summary = (row: typeof OriginRow.Type) =>
  FormOrigin.make({ origin: row.origin, createdAt: row.created_at });

// ?1 is the account, ?2 the organization and ?3 the public ID of the form.
const scopedForm = `
  SELECT f.id FROM forms f JOIN organization_members m ON m.organization_id = f.organization_id
  WHERE m.user_id = ?1 AND f.organization_id = ?2 AND f.public_id = ?3 AND m.role = 'admin'
`;

const list = Effect.fn("FormOrigins.list")(function* (form: FormScope) {
  const db = yield* database;
  const [forms, origins] = yield* d1(() =>
    db.batch([
      db.prepare(scopedForm).bind(form.userId, form.organizationId, form.formPublicId),
      db
        .prepare(`
      SELECT o.origin, o.created_at FROM form_origins o
      WHERE o.form_id IN (${scopedForm})
      ORDER BY o.created_at, o.origin
    `)
        .bind(form.userId, form.organizationId, form.formPublicId),
    ]),
  );
  const found = yield* decodeForms(forms?.results ?? []).pipe(Effect.mapError(unreadable));
  if (found.length === 0) return yield* FormOriginNotFound.make();
  const rows = yield* decodeOrigins(origins?.results ?? []).pipe(Effect.mapError(unreadable));
  return rows.map(summary);
});

const add = Effect.fn("FormOrigins.add")(function* (form: FormScope, origin: AllowedOrigin) {
  const db = yield* database;
  const now = yield* Clock.currentTimeMillis;
  // The WHERE clause of the SELECT keeps SQLite from reading ON CONFLICT as a join constraint.
  const [inserted, existing] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
      INSERT INTO form_origins (form_id, origin, created_at)
      SELECT f.id, ?4, ?5 FROM forms f
      WHERE f.id IN (${scopedForm})
      ON CONFLICT (form_id, origin) DO NOTHING
      RETURNING origin, created_at
    `)
        .bind(form.userId, form.organizationId, form.formPublicId, origin, now),
      db
        .prepare(`
      SELECT o.origin, o.created_at FROM form_origins o
      WHERE o.form_id IN (${scopedForm}) AND o.origin = ?4
    `)
        .bind(form.userId, form.organizationId, form.formPublicId, origin),
    ]),
  );
  const [created] = yield* decodeOrigins(inserted?.results ?? []).pipe(Effect.mapError(unreadable));
  if (created !== undefined) return { origin: summary(created), created: true };
  const [kept] = yield* decodeOrigins(existing?.results ?? []).pipe(Effect.mapError(unreadable));
  if (kept === undefined) return yield* FormOriginNotFound.make();
  return { origin: summary(kept), created: false };
});

const remove = Effect.fn("FormOrigins.remove")(function* (form: FormScope, origin: AllowedOrigin) {
  const db = yield* database;
  const scope = [form.userId, form.organizationId, form.formPublicId, origin] as const;
  // A success URL starts with its origin and a slash. Checking it in the DELETE
  // keeps a concurrent change of the success URL from leaving it on an unlisted origin.
  const [deleted, kept] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
      DELETE FROM form_origins
      WHERE form_id IN (${scopedForm}) AND origin = ?4
        AND NOT EXISTS (
          SELECT 1 FROM forms f
          WHERE f.id = form_origins.form_id
            AND substr(f.success_url, 1, length(?4) + 1) = ?4 || '/'
        )
      RETURNING origin, created_at
    `)
        .bind(...scope),
      db
        .prepare(`
      SELECT o.origin, o.created_at FROM form_origins o
      WHERE o.form_id IN (${scopedForm}) AND o.origin = ?4
    `)
        .bind(...scope),
    ]),
  );
  const rows = yield* decodeOrigins(deleted?.results ?? []).pipe(Effect.mapError(unreadable));
  if (rows.length > 0) return;
  const remaining = yield* decodeOrigins(kept?.results ?? []).pipe(Effect.mapError(unreadable));
  if (remaining.length > 0) return yield* OriginInUse.make();
  return yield* FormOriginNotFound.make();
});

export const formOriginsLive = Layer.succeed(FormOrigins, { list, add, remove });
