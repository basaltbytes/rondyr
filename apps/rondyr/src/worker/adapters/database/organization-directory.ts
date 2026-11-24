import { Effect, Layer, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { ManagedForm } from "../../../domain/forms/form.ts";
import { MemberRole } from "../../../domain/organizations/member-role.ts";
import {
  maxOrganizationDomains,
  OrganizationDomain,
  OrganizationDomainList,
} from "../../../domain/organizations/organization-domain.ts";
import type { SetupInbox } from "../../../domain/submissions/inbox-setup.ts";
import { InboxOrganization } from "../../../domain/submissions/inbox.ts";
import { InboxUnavailable } from "../../../domain/submissions/submission.rejection.ts";
import type { OrganizationId, UserId } from "../../../domain/submissions/submission.id.ts";
import {
  OrganizationDirectory,
  OrganizationDomainLimit,
  OrganizationDomainNotFound,
  type OrganizationScope,
} from "../../ports/organization-directory.ts";
import { StorageUnavailable } from "../../ports/storage.ts";
import { d1, database } from "./d1.ts";
import { managedFormColumns } from "./forms.ts";

const decodeOrganization = Schema.decodeUnknownEffect(InboxOrganization);
const decodeMemberships = Schema.decodeUnknownEffect(
  Schema.Array(InboxOrganization.mapFields((fields) => ({ ...fields, role: MemberRole }))),
);
const decodeRole = Schema.decodeUnknownEffect(Schema.Struct({ role: MemberRole }));
const decodeForms = Schema.decodeUnknownEffect(Schema.Array(ManagedForm));
const unavailable = () => InboxUnavailable.make();
const unreadable = () => StorageUnavailable.make();
const decodeDomainList = Schema.decodeUnknownEffect(
  Schema.Struct({ domains: Schema.fromJsonString(OrganizationDomainList) }),
);
const decodeDomainRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ domain: OrganizationDomain })),
);

const organizationsFor = Effect.fn("OrganizationDirectory.organizationsFor")(function* (
  userId: typeof UserId.Type,
) {
  const db = yield* database;
  const rows = yield* d1(() =>
    db
      .prepare(`
    SELECT o.id, o.name, m.role FROM organizations o
      JOIN organization_members m ON m.organization_id = o.id
    WHERE m.user_id = ? ORDER BY o.name, o.id
  `)
      .bind(userId)
      .all(),
  );
  return yield* decodeMemberships(rows.results);
}, Effect.mapError(unavailable));

const roleOf = Effect.fn("OrganizationDirectory.roleOf")(function* (scope: OrganizationScope) {
  const db = yield* database;
  const row = yield* d1(() =>
    db
      .prepare("SELECT role FROM organization_members WHERE user_id = ? AND organization_id = ?")
      .bind(scope.userId, scope.organizationId)
      .first(),
  );
  if (row === null) return null;
  const { role } = yield* decodeRole(row).pipe(Effect.mapError(unreadable));
  return role;
});

const formsOf = Effect.fn("OrganizationDirectory.formsOf")(function* (
  userId: typeof UserId.Type,
  organizationId: OrganizationId,
) {
  const db = yield* database;
  const results = yield* d1(() =>
    db
      .prepare(`
    SELECT ${managedFormColumns} FROM forms f JOIN organization_members m
      ON f.organization_id = m.organization_id WHERE m.user_id = ? AND f.organization_id = ?
    ORDER BY f.name, f.id
  `)
      .bind(userId, organizationId)
      .all(),
  );
  return yield* decodeForms(results.results);
}, Effect.mapError(unavailable));

const inboxFor = Effect.fn("OrganizationDirectory.inboxFor")(function* (
  organizationId: OrganizationId,
) {
  const db = yield* database;
  const [organization, forms] = yield* d1(() =>
    db.batch([
      db.prepare("SELECT id, name FROM organizations WHERE id = ?").bind(organizationId),
      db
        .prepare(`
      SELECT ${managedFormColumns} FROM forms f WHERE f.organization_id = ?
      ORDER BY f.name, f.id
    `)
        .bind(organizationId),
    ]),
  );
  const row = organization?.results[0];
  if (row === undefined) return null;
  const inbox = yield* decodeOrganization(row);
  const managedForms = yield* decodeForms(forms?.results);
  return { ...inbox, forms: managedForms };
}, Effect.mapError(unavailable));

const create = Effect.fn("OrganizationDirectory.create")(function* (
  userId: typeof UserId.Type,
  input: typeof SetupInbox.Type,
) {
  const db = yield* database;
  const organizationId = SecureRandom.uuidV4Unsafe();
  const formId = SecureRandom.uuidV4Unsafe();
  const publicId = SecureRandom.uuidV4Unsafe();
  yield* d1(() =>
    db.batch([
      db
        .prepare("INSERT INTO organizations (id, name) VALUES (?, ?)")
        .bind(organizationId, input.organizationName),
      db
        .prepare(
          "INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'admin')",
        )
        .bind(organizationId, userId),
      db
        .prepare(`
      INSERT INTO forms (id, organization_id, public_id, name, business_context)
      VALUES (?, ?, ?, ?, ?)
    `)
        .bind(formId, organizationId, publicId, input.formName, input.businessContext || null),
    ]),
  );
}, Effect.mapError(unavailable));

// ?1 is the account and ?2 the organization in every domain statement.
const membership = `SELECT 1 FROM organization_members WHERE user_id = ?1 AND organization_id = ?2`;
const scopedDomains = `
  SELECT (
    SELECT json_group_array(domain) FROM organization_domains WHERE organization_id = ?2
  ) AS domains WHERE EXISTS (${membership})
`;

const listDomains = Effect.fn("OrganizationDirectory.listDomains")(function* (
  scope: OrganizationScope,
) {
  const db = yield* database;
  const row = yield* d1(() =>
    db.prepare(scopedDomains).bind(scope.userId, scope.organizationId).first(),
  );
  if (row === null) return yield* OrganizationDomainNotFound.make();
  const { domains } = yield* decodeDomainList(row).pipe(Effect.mapError(unreadable));
  return domains.toSorted();
});

const addDomain = Effect.fn("OrganizationDirectory.addDomain")(function* (
  scope: OrganizationScope,
  domain: OrganizationDomain,
) {
  const db = yield* database;
  const key = [scope.userId, scope.organizationId] as const;
  const [inserted, declared] = yield* d1(() =>
    db.batch([
      db
        .prepare(`
        INSERT INTO organization_domains (organization_id, domain)
        SELECT ?2, ?3 WHERE EXISTS (${membership})
          AND (SELECT count(*) FROM organization_domains WHERE organization_id = ?2) < ?4
        ON CONFLICT (organization_id, domain) DO NOTHING
        RETURNING domain
      `)
        .bind(...key, domain, maxOrganizationDomains),
      db.prepare(scopedDomains).bind(...key),
    ]),
  );
  const rows = yield* decodeDomainRows(inserted?.results).pipe(Effect.mapError(unreadable));
  if (rows.length > 0) return true;
  const row = declared?.results[0];
  if (row === undefined) return yield* OrganizationDomainNotFound.make();
  const { domains } = yield* decodeDomainList(row).pipe(Effect.mapError(unreadable));
  if (domains.includes(domain)) return false;
  return yield* OrganizationDomainLimit.make();
});

const removeDomain = Effect.fn("OrganizationDirectory.removeDomain")(function* (
  scope: OrganizationScope,
  domain: OrganizationDomain,
) {
  const db = yield* database;
  const rows = yield* d1(() =>
    db
      .prepare(`
      DELETE FROM organization_domains WHERE organization_id = ?2 AND domain = ?3
        AND EXISTS (${membership})
      RETURNING domain
    `)
      .bind(scope.userId, scope.organizationId, domain)
      .all(),
  );
  const removed = yield* decodeDomainRows(rows.results).pipe(Effect.mapError(unreadable));
  if (removed.length === 0) return yield* OrganizationDomainNotFound.make();
});

export const organizationDirectoryLive = Layer.succeed(OrganizationDirectory, {
  organizationsFor,
  roleOf,
  formsOf,
  inboxFor,
  create,
  listDomains,
  addDomain,
  removeDomain,
});
