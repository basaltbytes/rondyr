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
} from "../../../domain/forms/form.ts";
import type { SetTurnstile } from "../../../domain/forms/turnstile.ts";
import { Forms, OrganizationFormNotFound, SuccessOriginNotListed } from "../../ports/forms.ts";
import type { OrganizationScope } from "../../ports/forms.ts";
import type { FormScope } from "../../ports/notification-targets.ts";
import { SealedSecret, SecretCipher } from "../../ports/secret-cipher.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { TurnstileVerifier, turnstileSecretOwner } from "../../ports/turnstile-verifier.ts";
import { d1, database } from "./d1.ts";

const decodeForms = Schema.decodeUnknownEffect(Schema.Array(ManagedForm));
const FormRow = Schema.Struct({ id: Schema.String });
const decodeFormIds = Schema.decodeUnknownEffect(Schema.Array(FormRow));
const unreadable = () => StorageUnavailable.make();

export const managedFormColumns = `
  name, public_id AS publicId, status, emoji, business_context AS businessContext,
  success_url AS successUrl, honeypot_field AS honeypotField, turnstile_site_key AS turnstileSiteKey
`;

// ?1 is the account, ?2 the organization and ?3 the public ID of the form.
const scopedForm = `
  SELECT f.id FROM forms f JOIN organization_members m ON m.organization_id = f.organization_id
  WHERE m.user_id = ?1 AND f.organization_id = ?2 AND f.public_id = ?3 AND m.role = 'admin'
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
    INSERT INTO forms (id, organization_id, public_id, name, business_context, emoji)
    SELECT ?3, m.organization_id, ?4, ?5, ?6, ?7 FROM organization_members m
    WHERE m.user_id = ?1 AND m.organization_id = ?2 AND m.role = 'admin'
    RETURNING ${managedFormColumns}
  `)
      .bind(
        organization.userId,
        organization.organizationId,
        id,
        publicId,
        input.name,
        input.businessContext || null,
        input.emoji ?? null,
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
      business_context = CASE WHEN ?5 = 1 THEN ?6 ELSE business_context END,
      emoji = COALESCE(?7, emoji)
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
        changes.emoji ?? null,
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

/** Fail with `OrganizationFormNotFound` unless the form is one of the account's. */
const findForm = Effect.fnUntraced(function* (form: FormScope) {
  const db = yield* database;
  const found = yield* d1(() =>
    db.prepare(scopedForm).bind(form.userId, form.organizationId, form.formPublicId).all(),
  );
  const forms = yield* decodeFormIds(found.results).pipe(Effect.mapError(unreadable));
  if (forms.length === 0) return yield* OrganizationFormNotFound.make();
});

/** Set both Turnstile keys, or clear them with null. */
const writeTurnstile = Effect.fnUntraced(function* (
  form: FormScope,
  keys: { readonly siteKey: string; readonly secret: SealedSecret } | null,
) {
  const db = yield* database;
  const updated = yield* d1(() =>
    db
      .prepare(`
    UPDATE forms SET turnstile_site_key = ?4, turnstile_secret = ?5
    WHERE id IN (${scopedForm})
    RETURNING ${managedFormColumns}
  `)
      .bind(
        form.userId,
        form.organizationId,
        form.formPublicId,
        keys?.siteKey ?? null,
        keys?.secret ?? null,
      )
      .all(),
  );
  return yield* returned(updated.results);
});

const clearTurnstile = Effect.fn("Forms.clearTurnstile")(function* (form: FormScope) {
  return yield* writeTurnstile(form, null);
});

const decodeSecrets = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ turnstile_secret: SealedSecret })),
);

/** The form's sealed Turnstile secret, or `OrganizationFormNotFound` when it has none. */
const storedTurnstileSecret = Effect.fnUntraced(function* (form: FormScope) {
  const db = yield* database;
  const found = yield* d1(() =>
    db
      .prepare(`
    SELECT turnstile_secret FROM forms
    WHERE id IN (${scopedForm}) AND turnstile_secret IS NOT NULL
  `)
      .bind(form.userId, form.organizationId, form.formPublicId)
      .all(),
  );
  const [row] = yield* decodeSecrets(found.results).pipe(Effect.mapError(unreadable));
  if (row === undefined) return yield* OrganizationFormNotFound.make();
  return row.turnstile_secret;
});

export const formsLive = Layer.effect(
  Forms,
  Effect.gen(function* () {
    const cipher = yield* SecretCipher;
    const verifier = yield* TurnstileVerifier;
    const setTurnstile = Effect.fn("Forms.setTurnstile")(function* (
      form: FormScope,
      settings: typeof SetTurnstile.Type,
    ) {
      const secret = yield* cipher.seal(
        settings.secretKey,
        turnstileSecretOwner(form.formPublicId),
      );
      // Another account's form gets 404 before any call to Siteverify.
      yield* findForm(form);
      yield* verifier.checkSecret(settings.secretKey);
      return yield* writeTurnstile(form, { siteKey: settings.siteKey, secret });
    });
    const checkTurnstile = Effect.fn("Forms.checkTurnstile")(function* (form: FormScope) {
      const sealed = yield* storedTurnstileSecret(form);
      return yield* cipher.open(sealed, turnstileSecretOwner(form.formPublicId)).pipe(
        Effect.flatMap(verifier.checkSecret),
        Effect.as("working" as const),
        Effect.catchTags({
          SecretUnreadable: () => Effect.succeed("unreadable" as const),
          TurnstileSecretRefused: () => Effect.succeed("refused" as const),
          TurnstileUnavailable: () => Effect.succeed("unchecked" as const),
        }),
      );
    });
    return {
      create,
      update,
      setStatus,
      setSuccessUrl,
      clearSuccessUrl,
      setHoneypotField,
      clearHoneypotField,
      setTurnstile,
      clearTurnstile,
      checkTurnstile,
    };
  }),
);
