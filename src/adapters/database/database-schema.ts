import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
    // `active` or `suspended`. A suspended form refuses submissions and keeps its messages.
    status: text().notNull().default("active"),
    // Normalized by parseSuccessUrl. Its origin is one of the form's allowed origins.
    successUrl: text("success_url"),
  },
  (table) => [
    check("forms_id_not_null", sql`${table.id} is not null`),
    index("forms_organization_id_idx").on(table.organizationId),
  ],
);

// The browser origins that may submit to a form. A form without a row accepts every origin.
export const formOrigins = sqliteTable(
  "form_origins",
  {
    formId: text("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    // Normalized by parseAllowedOrigin: scheme, host and optional port.
    origin: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.formId, table.origin] })],
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

export const notificationTargets = sqliteTable(
  "notification_targets",
  {
    id: text().primaryKey().notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    formId: text("form_id")
      .notNull()
      .references(() => forms.id),
    type: text().notNull(),
    // Settings of the target as JSON, decoded by the provider of its type.
    configuration: text().notNull(),
    active: integer({ mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("notification_targets_form_idx").on(table.formId, table.active)],
);

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: text().primaryKey().notNull(),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => notificationTargets.id, { onDelete: "cascade" }),
    status: text().notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    // When the next attempt may start: the creation time, the end of a retry
    // delay, or the end of the running attempt's lease.
    nextAttemptAt: integer("next_attempt_at").notNull(),
    leaseUntil: integer("lease_until").notNull().default(0),
    publishedAt: integer("published_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("deliveries_submission_target_idx").on(table.submissionId, table.targetId),
    index("deliveries_due_idx")
      .on(table.nextAttemptAt, table.leaseUntil)
      .where(sql`${table.status} IN ('pending', 'retrying', 'processing')`),
    check(
      "deliveries_status_check",
      sql`${table.status} IN ('pending', 'processing', 'delivered', 'retrying', 'failed')`,
    ),
  ],
);

export const deliveryAttempts = sqliteTable(
  "delivery_attempts",
  {
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "cascade" }),
    attempt: integer().notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    // NULL while the attempt runs.
    outcome: text(),
    error: text(),
  },
  (table) => [
    primaryKey({ columns: [table.deliveryId, table.attempt] }),
    check(
      "delivery_attempts_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('delivered', 'retryable-failure', 'permanent-failure', 'interrupted')`,
    ),
  ],
);
