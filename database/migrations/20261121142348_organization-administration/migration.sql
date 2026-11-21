CREATE TABLE `email_recipient_confirmations` (
	`organization_id` text NOT NULL,
	`address` text NOT NULL,
	`token_hash` text,
	`token_expires_at` integer,
	`confirmed_at` integer,
	`emails_day` text,
	`emails_sent` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `email_recipient_confirmations_pk` PRIMARY KEY(`organization_id`, `address`),
	CONSTRAINT `fk_email_recipient_confirmations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `organization_invitations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`cancelled_at` integer,
	CONSTRAINT `fk_organization_invitations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "organization_invitations_id_not_null" CHECK("id" is not null)
);
--> statement-breakpoint
CREATE TABLE `submission_deletions` (
	`submission_id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`deleted_at` integer NOT NULL,
	`deleted_by` text,
	`cause` text NOT NULL,
	CONSTRAINT `fk_submission_deletions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `organization_members` ADD `role` text DEFAULT 'reviewer' NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `accepted_retention_days` integer;--> statement-breakpoint
ALTER TABLE `organizations` ADD `quarantine_retention_days` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `email_recipient_confirmations_token_unique` ON `email_recipient_confirmations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `email_recipient_confirmations_address_idx` ON `email_recipient_confirmations` (`address`,`emails_day`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_token_unique` ON `organization_invitations` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_pending_unique` ON `organization_invitations` (`organization_id`,`email`) WHERE "organization_invitations"."accepted_at" is null and "organization_invitations"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX `organization_invitations_email_idx` ON `organization_invitations` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `submission_deletions_organization_idx` ON `submission_deletions` (`organization_id`,`deleted_at`);--> statement-breakpoint
-- Every member before roles had every right: each keeps them as an admin.
UPDATE organization_members SET role = 'admin';--> statement-breakpoint
-- The recipients of the email destinations that exist before confirmations keep their
-- messages: each one is confirmed for the organization of its destination.
INSERT INTO email_recipient_confirmations (organization_id, address, confirmed_at, emails_sent, created_at)
SELECT DISTINCT t.organization_id, lower(r.value), CAST(strftime('%s', 'now') AS INTEGER) * 1000, 0,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM notification_targets t,
  json_each(CASE WHEN json_valid(t.configuration) THEN t.configuration ELSE '{}' END, '$.recipients') r
WHERE t.type = 'email' AND r.type = 'text'
ON CONFLICT (organization_id, address) DO NOTHING;
