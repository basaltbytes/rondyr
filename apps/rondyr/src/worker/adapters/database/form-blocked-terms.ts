import { Clock, Effect, Layer, Schema } from "effect";

import {
  BlockedTerm,
  FormBlockedTerm,
  maxFormBlockedTerms,
  maxOrganizationBlockedTerms,
} from "../../../domain/forms/blocked-term.ts";
import {
  FormBlockedTermLimit,
  FormBlockedTermNotFound,
  FormBlockedTerms,
} from "../../ports/form-blocked-terms.ts";
import type { FormScope } from "../../ports/notification-targets.ts";
import type { OrganizationScope } from "../../ports/organization-directory.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";

const TermRow = Schema.Struct({ term: BlockedTerm, created_at: Schema.Int });
const ScopeRow = Schema.Struct({ id: Schema.String });

const decodeTerms = Schema.decodeUnknownEffect(Schema.Array(TermRow));
const decodeScope = Schema.decodeUnknownEffect(Schema.Array(ScopeRow));

const unreadable = () => StorageUnavailable.make();

const summary = (row: typeof TermRow.Type) =>
  FormBlockedTerm.make({ term: row.term, createdAt: row.created_at });

// ?1 is the account, ?2 the organization and ?3 the public ID of the form.
const scopedForm = `
  SELECT f.id FROM forms f JOIN organization_members m ON m.organization_id = f.organization_id
  WHERE m.user_id = ?1 AND f.organization_id = ?2 AND f.public_id = ?3 AND m.role = 'admin'
`;

// ?1 is the account and ?2 is the organization.
const scopedOrganization = `
  SELECT m.organization_id AS id FROM organization_members m
  WHERE m.user_id = ?1 AND m.organization_id = ?2 AND m.role = 'admin'
`;

const list = Effect.fn("FormBlockedTerms.list")(function* (form: FormScope) {
  const db = yield* database;
  const [forms, terms] = yield* d1(() =>
    db.batch([
      db.prepare(scopedForm).bind(form.userId, form.organizationId, form.formPublicId),
      db
        .prepare(`
      SELECT t.term, t.created_at FROM form_blocked_terms t
      WHERE t.form_id IN (${scopedForm})
      ORDER BY t.created_at, t.term
    `)
        .bind(form.userId, form.organizationId, form.formPublicId),
    ]),
  );
  const found = yield* decodeScope(forms?.results ?? []).pipe(Effect.mapError(unreadable));
  if (found.length === 0) return yield* FormBlockedTermNotFound.make();
  const rows = yield* decodeTerms(terms?.results ?? []).pipe(Effect.mapError(unreadable));
  return rows.map(summary);
});

const add = Effect.fn("FormBlockedTerms.add")(function* (form: FormScope, term: BlockedTerm) {
  const db = yield* database;
  const now = yield* Clock.currentTimeMillis;
  // The WHERE clause of the SELECT keeps SQLite from reading ON CONFLICT as a join constraint.
  const [inserted, existing, forms] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
      INSERT INTO form_blocked_terms (form_id, term, created_at)
      SELECT f.id, ?4, ?5 FROM forms f
      WHERE f.id IN (${scopedForm})
        AND (SELECT COUNT(*) FROM form_blocked_terms WHERE form_id = f.id) < ?6
      ON CONFLICT (form_id, term) DO NOTHING
      RETURNING term, created_at
    `)
        .bind(form.userId, form.organizationId, form.formPublicId, term, now, maxFormBlockedTerms),
      db
        .prepare(`
      SELECT t.term, t.created_at FROM form_blocked_terms t
      WHERE t.form_id IN (${scopedForm}) AND t.term = ?4
    `)
        .bind(form.userId, form.organizationId, form.formPublicId, term),
      db.prepare(scopedForm).bind(form.userId, form.organizationId, form.formPublicId),
    ]),
  );
  const [created] = yield* decodeTerms(inserted?.results ?? []).pipe(Effect.mapError(unreadable));
  if (created !== undefined) return { term: summary(created), created: true };
  const [kept] = yield* decodeTerms(existing?.results ?? []).pipe(Effect.mapError(unreadable));
  if (kept !== undefined) return { term: summary(kept), created: false };
  const found = yield* decodeScope(forms?.results ?? []).pipe(Effect.mapError(unreadable));
  if (found.length === 0) return yield* FormBlockedTermNotFound.make();
  return yield* FormBlockedTermLimit.make();
});

const remove = Effect.fn("FormBlockedTerms.remove")(function* (form: FormScope, term: BlockedTerm) {
  const db = yield* database;
  const rows = yield* d1(() =>
    db
      .prepare(`
      DELETE FROM form_blocked_terms
      WHERE form_id IN (${scopedForm}) AND term = ?4
      RETURNING term, created_at
    `)
      .bind(form.userId, form.organizationId, form.formPublicId, term)
      .all(),
  );
  const deleted = yield* decodeTerms(rows.results).pipe(Effect.mapError(unreadable));
  if (deleted.length === 0) return yield* FormBlockedTermNotFound.make();
});

const listForOrganization = Effect.fn("FormBlockedTerms.listForOrganization")(function* (
  organization: OrganizationScope,
) {
  const db = yield* database;
  const [orgs, terms] = yield* d1(() =>
    db.batch([
      db.prepare(scopedOrganization).bind(organization.userId, organization.organizationId),
      db
        .prepare(`
      SELECT t.term, t.created_at FROM organization_blocked_terms t
      WHERE t.organization_id IN (${scopedOrganization})
      ORDER BY t.created_at, t.term
    `)
        .bind(organization.userId, organization.organizationId),
    ]),
  );
  const found = yield* decodeScope(orgs?.results ?? []).pipe(Effect.mapError(unreadable));
  if (found.length === 0) return yield* FormBlockedTermNotFound.make();
  const rows = yield* decodeTerms(terms?.results ?? []).pipe(Effect.mapError(unreadable));
  return rows.map(summary);
});

const addForOrganization = Effect.fn("FormBlockedTerms.addForOrganization")(function* (
  organization: OrganizationScope,
  term: BlockedTerm,
) {
  const db = yield* database;
  const now = yield* Clock.currentTimeMillis;
  const [inserted, existing, orgs] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
      INSERT INTO organization_blocked_terms (organization_id, term, created_at)
      SELECT o.id, ?3, ?4 FROM organizations o
      WHERE o.id IN (${scopedOrganization})
        AND (SELECT COUNT(*) FROM organization_blocked_terms WHERE organization_id = o.id) < ?5
      ON CONFLICT (organization_id, term) DO NOTHING
      RETURNING term, created_at
    `)
        .bind(
          organization.userId,
          organization.organizationId,
          term,
          now,
          maxOrganizationBlockedTerms,
        ),
      db
        .prepare(`
      SELECT t.term, t.created_at FROM organization_blocked_terms t
      WHERE t.organization_id IN (${scopedOrganization}) AND t.term = ?3
    `)
        .bind(organization.userId, organization.organizationId, term),
      db.prepare(scopedOrganization).bind(organization.userId, organization.organizationId),
    ]),
  );
  const [created] = yield* decodeTerms(inserted?.results ?? []).pipe(Effect.mapError(unreadable));
  if (created !== undefined) return { term: summary(created), created: true };
  const [kept] = yield* decodeTerms(existing?.results ?? []).pipe(Effect.mapError(unreadable));
  if (kept !== undefined) return { term: summary(kept), created: false };
  const found = yield* decodeScope(orgs?.results ?? []).pipe(Effect.mapError(unreadable));
  if (found.length === 0) return yield* FormBlockedTermNotFound.make();
  return yield* FormBlockedTermLimit.make();
});

const removeForOrganization = Effect.fn("FormBlockedTerms.removeForOrganization")(function* (
  organization: OrganizationScope,
  term: BlockedTerm,
) {
  const db = yield* database;
  const rows = yield* d1(() =>
    db
      .prepare(`
      DELETE FROM organization_blocked_terms
      WHERE organization_id IN (${scopedOrganization}) AND term = ?3
      RETURNING term, created_at
    `)
      .bind(organization.userId, organization.organizationId, term)
      .all(),
  );
  const deleted = yield* decodeTerms(rows.results).pipe(Effect.mapError(unreadable));
  if (deleted.length === 0) return yield* FormBlockedTermNotFound.make();
});

export const formBlockedTermsLive = Layer.succeed(FormBlockedTerms, {
  list,
  add,
  remove,
  listForOrganization,
  addForOrganization,
  removeForOrganization,
});
