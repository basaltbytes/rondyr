CREATE TABLE `organization_members` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	CONSTRAINT `organization_members_pk` PRIMARY KEY(`organization_id`, `user_id`),
	CONSTRAINT `fk_organization_members_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_organization_members_user_id_auth_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `outbox_events` (
	`submission_id` text PRIMARY KEY,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`published_at` integer,
	`handed_off_at` integer,
	CONSTRAINT `fk_outbox_events_submission_id_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `submission_inbox` (
	`submission_id` text PRIMARY KEY,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text,
	CONSTRAINT `fk_submission_inbox_submission_id_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`form_id` text NOT NULL,
	`fields` text NOT NULL,
	`received_at` integer NOT NULL,
	CONSTRAINT `fk_submissions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_submissions_form_id_forms_id_fk` FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`)
);
--> statement-breakpoint
ALTER TABLE `forms` ADD `business_context` text;--> statement-breakpoint
CREATE INDEX `organization_members_user_idx` ON `organization_members` (`user_id`);--> statement-breakpoint
CREATE INDEX `outbox_pending_idx` ON `outbox_events` (`lease_until`,`published_at`) WHERE "outbox_events"."handed_off_at" IS NULL;--> statement-breakpoint
CREATE INDEX `submissions_inbox_idx` ON `submissions` (`organization_id`,`received_at`,`id`);--> statement-breakpoint
CREATE INDEX `submissions_form_received_idx` ON `submissions` (`form_id`,`received_at`);