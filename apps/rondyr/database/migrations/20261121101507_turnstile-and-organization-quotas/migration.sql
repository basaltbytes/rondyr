CREATE TABLE `organization_daily_usage` (
	`organization_id` text PRIMARY KEY,
	`day` text NOT NULL,
	`submissions` integer NOT NULL,
	`classifications` integer NOT NULL,
	CONSTRAINT `fk_organization_daily_usage_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `forms` ADD `turnstile_site_key` text;--> statement-breakpoint
ALTER TABLE `forms` ADD `turnstile_secret` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `daily_submission_limit` integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` ADD `daily_classification_limit` integer DEFAULT 1000 NOT NULL;