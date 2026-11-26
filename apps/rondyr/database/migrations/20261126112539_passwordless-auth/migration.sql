CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY,
	`purpose` text NOT NULL,
	`challenge_hash` text NOT NULL UNIQUE,
	`payload_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_email_otps` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `auth_passkeys` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`credential_id` text NOT NULL UNIQUE,
	`public_key` text NOT NULL,
	`algorithm` integer NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`rp_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	CONSTRAINT `fk_auth_passkeys_user_id_auth_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `auth_users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
DROP INDEX IF EXISTS `auth_accounts_user_id_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `auth_accounts_provider_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `auth_verifications_identifier_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `password_resets_user_idx`;--> statement-breakpoint
CREATE INDEX `auth_challenges_expires_at_idx` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `auth_email_otps_email_created_idx` ON `auth_email_otps` (`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `auth_email_otps_expires_at_idx` ON `auth_email_otps` (`expires_at`);--> statement-breakpoint
CREATE INDEX `auth_passkeys_user_id_idx` ON `auth_passkeys` (`user_id`);--> statement-breakpoint
DROP TABLE `auth_accounts`;--> statement-breakpoint
DROP TABLE `auth_rate_limits`;--> statement-breakpoint
DROP TABLE `auth_verifications`;--> statement-breakpoint
DROP TABLE `password_resets`;