import { Effect, Layer, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

import { ManagedForm } from "../../domain/forms/form.ts";
import type { SetupInbox } from "../../domain/submissions/inbox-setup.ts";
import { InboxOrganization } from "../../domain/submissions/inbox.ts";
import { InboxUnavailable } from "../../domain/submissions/submission.rejection.ts";
import type { OrganizationId, UserId } from "../../domain/submissions/submission.id.ts";
import { OrganizationDirectory } from "../../ports/organization-directory.ts";
import { d1, database } from "./d1.ts";
import { managedFormColumns } from "./forms.ts";

const decodeOrganizations = Schema.decodeUnknownEffect(Schema.Array(InboxOrganization));
const decodeForms = Schema.decodeUnknownEffect(Schema.Array(ManagedForm));
const unavailable = () => InboxUnavailable.make();

const organizationsFor = Effect.fn("OrganizationDirectory.organizationsFor")(function* (
  userId: typeof UserId.Type,
) {
  const db = yield* database;
  const rows = yield* d1(() =>
    db
      .prepare(`
    SELECT o.id, o.name FROM organizations o JOIN organization_members m ON m.organization_id = o.id
    WHERE m.user_id = ? ORDER BY o.name, o.id
  `)
      .bind(userId)
      .all(),
  );
  return yield* decodeOrganizations(rows.results);
}, Effect.mapError(unavailable));

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
        .prepare("INSERT INTO organization_members (organization_id, user_id) VALUES (?, ?)")
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

export const organizationDirectoryLive = Layer.succeed(OrganizationDirectory, {
  organizationsFor,
  formsOf,
  create,
});
