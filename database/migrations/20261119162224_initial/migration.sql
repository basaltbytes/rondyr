CREATE TABLE `forms` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`public_id` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	CONSTRAINT `fk_forms_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT "forms_id_not_null" CHECK("id" is not null)
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	CONSTRAINT "organizations_id_not_null" CHECK("id" is not null)
);
--> statement-breakpoint
CREATE INDEX `forms_organization_id_idx` ON `forms` (`organization_id`);