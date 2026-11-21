CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY,
	`submission_id` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`published_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_deliveries_submission_id_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_deliveries_target_id_notification_targets_id_fk` FOREIGN KEY (`target_id`) REFERENCES `notification_targets`(`id`) ON DELETE CASCADE,
	CONSTRAINT "deliveries_status_check" CHECK("status" IN ('pending', 'processing', 'delivered', 'retrying', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `delivery_attempts` (
	`delivery_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text,
	`error` text,
	CONSTRAINT `delivery_attempts_pk` PRIMARY KEY(`delivery_id`, `attempt`),
	CONSTRAINT `fk_delivery_attempts_delivery_id_deliveries_id_fk` FOREIGN KEY (`delivery_id`) REFERENCES `deliveries`(`id`) ON DELETE CASCADE,
	CONSTRAINT "delivery_attempts_outcome_check" CHECK("outcome" IS NULL OR "outcome" IN ('delivered', 'retryable-failure', 'permanent-failure', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE `notification_targets` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`form_id` text NOT NULL,
	`type` text NOT NULL,
	`configuration` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_notification_targets_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_notification_targets_form_id_forms_id_fk` FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_submission_target_idx` ON `deliveries` (`submission_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `deliveries_due_idx` ON `deliveries` (`next_attempt_at`,`lease_until`) WHERE "deliveries"."status" IN ('pending', 'retrying', 'processing');--> statement-breakpoint
CREATE INDEX `notification_targets_form_idx` ON `notification_targets` (`form_id`,`active`);