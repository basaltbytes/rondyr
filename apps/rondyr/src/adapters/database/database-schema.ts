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

import {
  defaultDailyClassifications,
  defaultDailySubmissions,
} from "../../domain/organizations/organization-quotas.ts";
import { user } from "./auth-schema.ts";

export const organizations = sqliteTable(
  "organizations",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    dailySubmissionLimit: integer("daily_submission_limit")
      .notNull()
      .default(defaultDailySubmissions),
    dailyClassificationLimit: integer("daily_classification_limit")
      .notNull()
      .default(defaultDailyClassifications),
    // Days of retention from the reception of a message, or NULL to keep it.
    acceptedRetentionDays: integer("accepted_retention_days"),
    quarantineRetentionDays: integer("quarantine_retention_days"),
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
    // One emoji shown next to the name in the dashboard, or NULL.
    emoji: text(),
    // `active` or `suspended`. A suspended form refuses submissions and keeps its messages.
    status: text().notNull().default("active"),
    // Normalized by parseSuccessUrl. Its origin is one of the form's allowed origins.
    successUrl: text("success_url"),
    // The name of a field that people leave empty and bots fill in, or NULL.
    honeypotField: text("honeypot_field"),
    turnstileSiteKey: text("turnstile_site_key"),
    turnstileSecret: text("turnstile_secret"),
  },
  (table) => [
    check("forms_id_not_null", sql`${table.id} is not null`),
    index("forms_organization_id_idx").on(table.organizationId),
  ],
);

export const organizationDailyUsage = sqliteTable("organization_daily_usage", {
  organizationId: text("organization_id")
    .primaryKey()
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  day: text().notNull(),
  // Stored submissions of `day`, junk excepted.
  submissions: integer().notNull(),
  classifications: integer().notNull(),
  // Stored junk of `day`: see `junkIntakeReasons`. A statement that changes `day`
  // must reset this counter with the others.
  junk: integer().notNull().default(0),
});

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
    // `reviewer` or `admin`, decoded by MemberRole. Every statement of the Worker
    // names the role. The default is for the Worker version before roles: during
    // a deployment it still runs after the migration, and a member that it adds,
    // the creator of an organization, had every right.
    role: text().notNull().default("admin"),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("organization_members_user_idx").on(table.userId),
  ],
);

// An address invited to an organization with a role. D1 keeps the hash of the
// link's secret only. An invitation is pending while it has neither
// `accepted_at` nor `cancelled_at`, and usable while it has not expired either.
export const organizationInvitations = sqliteTable(
  "organization_invitations",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // In lowercase, as Better Auth stores the address of an account.
    email: text().notNull(),
    role: text().notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: integer("accepted_at"),
    cancelledAt: integer("cancelled_at"),
  },
  (table) => [
    check("organization_invitations_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("organization_invitations_token_unique").on(table.tokenHash),
    uniqueIndex("organization_invitations_pending_unique")
      .on(table.organizationId, table.email)
      .where(sql`${table.acceptedAt} is null and ${table.cancelledAt} is null`),
    index("organization_invitations_email_idx").on(table.email, table.createdAt),
  ],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenSuffix: text("token_suffix").notNull(),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    check("api_tokens_id_not_null", sql`${table.id} is not null`),
    uniqueIndex("api_tokens_hash_unique").on(table.tokenHash),
    index("api_tokens_active_by_organization")
      .on(table.organizationId, table.createdAt, table.id)
      .where(sql`${table.revokedAt} is null`),
  ],
);

// An address that an organization may email. It gets deliveries and tests once its
// owner has confirmed it with the link of a confirmation email; D1 keeps the hash
// of the link only. `emails_day` and `emails_sent` count the confirmation emails
// of the address on its last UTC day, summed across organizations.
export const emailRecipientConfirmations = sqliteTable(
  "email_recipient_confirmations",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    // In lowercase: two recipients that differ only by case are the same.
    address: text().notNull(),
    tokenHash: text("token_hash"),
    tokenExpiresAt: integer("token_expires_at"),
    confirmedAt: integer("confirmed_at"),
    emailsDay: text("emails_day"),
    emailsSent: integer("emails_sent").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.address] }),
    uniqueIndex("email_recipient_confirmations_token_unique").on(table.tokenHash),
    index("email_recipient_confirmations_address_idx").on(table.address, table.emailsDay),
  ],
);

export const organizationDomains = sqliteTable(
  "organization_domains",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domain: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.domain] })],
);

export const organizationClassificationPolicies = sqliteTable(
  "organization_classification_policies",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policy: text().notNull(),
  },
  (table) => [
    check(
      "classification_policies_organization_id_not_null",
      sql`${table.organizationId} is not null`,
    ),
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
    // Why intake quarantined the submission before any classifier ran, or NULL.
    // Written with the submission, so every hand-off reads the same value.
    intakeReason: text("intake_reason"),
    senderFingerprint: text("sender_fingerprint"),
    contentFingerprint: text("content_fingerprint"),
    priorSameSender: integer("prior_same_sender").notNull().default(0),
    priorSameContent: integer("prior_same_content").notNull().default(0),
    // The Idempotency-Key of a server intake, unique per form. It lives as long as the submission.
    idempotencyKey: text("idempotency_key"),
  },
  (table) => [
    index("submissions_inbox_idx").on(table.organizationId, table.receivedAt, table.id),
    index("submissions_form_received_idx").on(table.formId, table.receivedAt),
    index("submissions_sender_repetition_idx")
      .on(table.organizationId, table.senderFingerprint, table.receivedAt)
      .where(sql`${table.senderFingerprint} is not null`),
    index("submissions_content_repetition_idx")
      .on(table.organizationId, table.contentFingerprint, table.receivedAt)
      .where(sql`${table.contentFingerprint} is not null`),
    uniqueIndex("submissions_form_idempotency_key_idx")
      .on(table.formId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

// A message deleted by a member or by the retention period, without its content:
// the organization, its ID, when, and the account that deleted it, which is NULL
// for the retention period.
export const submissionDeletions = sqliteTable(
  "submission_deletions",
  {
    submissionId: text("submission_id").primaryKey().notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deletedAt: integer("deleted_at").notNull(),
    deletedBy: text("deleted_by"),
    // `request` or `retention`.
    cause: text().notNull(),
  },
  (table) => [
    check("submission_deletions_submission_id_not_null", sql`${table.submissionId} is not null`),
    index("submission_deletions_organization_idx").on(table.organizationId, table.deletedAt),
  ],
);

// A password reset link of an account. D1 keeps the hash of its secret only. A
// link works once, until `expires_at`; using one uses every link of the account.
export const passwordResets = sqliteTable(
  "password_resets",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
  },
  (table) => [
    check("password_resets_token_hash_not_null", sql`${table.tokenHash} is not null`),
    index("password_resets_user_idx").on(table.userId, table.createdAt),
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
    /** Publications since intake or since the last manual retry. */
    publicationCount: integer("publication_count").notNull().default(0),
    /** When the Cron stopped republishing the event. A manual retry clears it. */
    stuckAt: integer("stuck_at"),
  },
  (table) => [
    // The Cron reads this index every minute; stuck events stay out of it until a retry.
    // A new name: drizzle-kit does not compare the condition of a partial index.
    index("outbox_due_idx")
      .on(table.leaseUntil, table.publishedAt)
      .where(sql`${table.handedOffAt} IS NULL AND ${table.stuckAt} IS NULL`),
    // The status page and the stuck list read the stuck events alone.
    index("outbox_stuck_idx")
      .on(table.stuckAt)
      .where(sql`${table.handedOffAt} IS NULL AND ${table.stuckAt} IS NOT NULL`),
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
  label: text(),
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
