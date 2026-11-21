CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_suffix` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`revoked_at` integer,
	CONSTRAINT `fk_api_tokens_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "api_tokens_id_not_null" CHECK("id" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_active_by_organization` ON `api_tokens` (`organization_id`,`created_at`,`id`) WHERE "api_tokens"."revoked_at" is null;