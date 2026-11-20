import { Effect, Layer, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import {
  ManagedForm,
  successUrlOrigin,
  type CreateForm,
  type FormStatus,
  type HoneypotField,
  type SuccessUrl,
  type UpdateForm,
} from "../../domain/forms/form.ts";
import { Forms, OrganizationFormNotFound, SuccessOriginNotListed } from "../../ports/forms.ts";
import type { OrganizationScope } from "../../ports/forms.ts";
import type { FormScope } from "../../ports/notification-targets.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const decodeForms = Schema.decodeUnknownEffect(Schema.Array(ManagedForm));
const FormRow = Schema.Struct({ id: Schema.String });
const decodeFormIds = Schema.decodeUnknownEffect(Schema.Array(FormRow));
const unreadable = () => StorageUnavailable.make();

export const managedFormColumns = `
  name, public_id AS publicId, status, business_context AS businessContext,
  success_url AS successUrl, honeypot_field AS honeypotField
`;

// ?1 is the account, ?2 the organization and ?3 the public ID of the form.
const scopedForm = `
  SELECT f.id FROM forms f JOIN organization_members m ON m.organization_id = f.organization_id
  WHERE m.user_id = ?1 AND f.organization_id = ?2 AND f.public_id = ?3
`;

/** The single form a statement returned, or `OrganizationFormNotFound`. */
const returned = Effect.fnUntraced(function* (rows: ReadonlyArray<unknown> | undefined) {
  const [form] = yield* decodeForms(rows ?? []).pipe(Effect.mapError(unreadable));
  if (form === undefined) return yield* OrganizationFormNotFound.make();
  return form;
});

const create = Effect.fn("Forms.create")(function* (
  organization: OrganizationScope,
  input: typeof CreateForm.Type,
) {
  const db = yield* database;
  const id = SecureRandom.uuidV4Unsafe();
  const publicId = SecureRandom.uuidV4Unsafe();
  const inserted = yield* d1(() =>
    db
      .prepare(`
    INSERT INTO forms (id, organization_id, public_id, name, business_context)
    SELECT ?3, m.organization_id, ?4, ?5, ?6 FROM organization_members m
    WHERE m.user_id = ?1 AND m.organization_id = ?2
    RETURNING ${managedFormColumns}
  `)
      .bind(
        organization.userId,
        organization.organizationId,
        id,
        publicId,
        input.name,
        input.businessContext || null,
      )
      .all(),
  );
  return yield* returned(inserted.results);
});

const update = Effect.fn("Forms.update")(function* (
  form: FormScope,
  changes: typeof UpdateForm.Type,
) {
  const db = yield* database;
  const context = changes.businessContext;
  const updated = yield* d1(() =>
    db
      .prepare(`
    UPDATE forms SET
      name = COALESCE(?4, name),
      business_context = CASE WHEN ?5 = 1 THEN ?6 ELSE business_context END
    WHERE id IN (${scopedForm})
    RETURNING ${managedFormColumns}
  `)
      .bind(
        form.userId,
        form.organizationId,
        form.formPublicId,
        changes.name ?? null,
        context === undefined ? 0 : 1,
        context || null,
      )
      .all(),
  );
  return yield* returned(updated.results);
});

const setStatus = Effect.fn("Forms.setStatus")(function* (form: FormScope, status: FormStatus) {
  const db = yield* database;
  const updated = yield* d1(() =>
    db
      .prepare(`
    UPDATE forms SET status = ?4 WHERE id IN (${scopedForm}) RETURNING ${managedFormColumns}
  `)
      .bind(form.userId, form.organizationId, form.formPublicId, status)
      .all(),
  );
  return yield* returned(updated.results);
});

const setSuccessUrl = Effect.fn("Forms.setSuccessUrl")(function* (
  form: FormScope,
  url: SuccessUrl,
) {
  const db = yield* database;
  const scope = [form.userId, form.organizationId, form.formPublicId] as const;
  // One statement checks the allowed origin and writes the URL, so a concurrent
  // removal of the origin cannot leave a success URL on an unlisted origin.
  const [updated, found] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
      UPDATE forms SET success_url = ?4
      WHERE id IN (${scopedForm})
        AND EXISTS (SELECT 1 FROM form_origins o WHERE o.form_id = forms.id AND o.origin = ?5)
      RETURNING ${managedFormColumns}
    `)
        .bind(...scope, url, successUrlOrigin(url)),
      db.prepare(scopedForm).bind(...scope),
    ]),
  );
  const forms = yield* decodeFormIds(found?.results ?? []).pipe(Effect.mapError(unreadable));
  if (forms.length === 0) return yield* OrganizationFormNotFound.make();
  const [changed] = yield* decodeForms(updated?.results ?? []).pipe(Effect.mapError(unreadable));
  if (changed === undefined) return yield* SuccessOriginNotListed.make();
  return changed;
});

const clearSuccessUrl = Effect.fn("Forms.clearSuccessUrl")(function* (form: FormScope) {
  const db = yield* database;
  const updated = yield* d1(() =>
    db
      .prepare(`
    UPDATE forms SET success_url = NULL WHERE id IN (${scopedForm})
    RETURNING ${managedFormColumns}
  `)
      .bind(form.userId, form.organizationId, form.formPublicId)
      .all(),
  );
  return yield* returned(updated.results);
});

/** Set the honeypot field, or clear it with null. */
const writeHoneypotField = Effect.fnUntraced(function* (form: FormScope, field: string | null) {
  const db = yield* database;
  const updated = yield* d1(() =>
    db
      .prepare(`
    UPDATE forms SET honeypot_field = ?4 WHERE id IN (${scopedForm})
    RETURNING ${managedFormColumns}
  `)
      .bind(form.userId, form.organizationId, form.formPublicId, field)
      .all(),
  );
  return yield* returned(updated.results);
});

const setHoneypotField = Effect.fn("Forms.setHoneypotField")(function* (
  form: FormScope,
  field: typeof HoneypotField.Type,
) {
  return yield* writeHoneypotField(form, field);
});

const clearHoneypotField = Effect.fn("Forms.clearHoneypotField")(function* (form: FormScope) {
  return yield* writeHoneypotField(form, null);
});

export const formsLive = Layer.succeed(Forms, {
  create,
  update,
  setStatus,
  setSuccessUrl,
  clearSuccessUrl,
  setHoneypotField,
  clearHoneypotField,
});
