import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { user } from "./auth-schema.ts";

export const organizations = sqliteTable(
  "organizations",
  {
    id: text().primaryKey(),
    name: text().notNull(),
  },
  // SQLite permits NULL in a non-integer primary key unless explicitly constrained.
  (table) => [check("organizations_id_not_null", sql`${table.id} is not null`)],
);

export const forms = sqliteTable(
  "forms",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    publicId: text("public_id").notNull().unique(),
    businessContext: text("business_context"),
    name: text().notNull(),
  },
  (table) => [
    check("forms_id_not_null", sql`${table.id} is not null`),
    index("forms_organization_id_idx").on(table.organizationId),
  ],
);

export const organizationMembers = sqliteTable(
  "organization_members",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("organization_members_user_idx").on(table.userId),
  ],
);

export const submissions = sqliteTable(
  "submissions",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    formId: text("form_id")
      .notNull()
      .references(() => forms.id),
    fields: text().notNull(),
    receivedAt: integer("received_at").notNull(),
  },
  (table) => [
    index("submissions_inbox_idx").on(table.organizationId, table.receivedAt, table.id),
    index("submissions_form_received_idx").on(table.formId, table.receivedAt),
  ],
);

export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    submissionId: text("submission_id")
      .primaryKey()
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    leaseUntil: integer("lease_until").notNull().default(0),
    publishedAt: integer("published_at"),
    handedOffAt: integer("handed_off_at"),
  },
  (table) => [
    index("outbox_pending_idx")
      .on(table.leaseUntil, table.publishedAt)
      .where(sql`${table.handedOffAt} IS NULL`),
  ],
);

export const submissionInbox = sqliteTable("submission_inbox", {
  submissionId: text("submission_id")
    .primaryKey()
    .notNull()
    .references(() => submissions.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  status: text().notNull(),
  reason: text(),
});
