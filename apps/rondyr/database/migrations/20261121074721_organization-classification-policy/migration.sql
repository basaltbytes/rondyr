CREATE TABLE `organization_classification_policies` (
	`organization_id` text PRIMARY KEY,
	`policy` text NOT NULL,
	CONSTRAINT `fk_organization_classification_policies_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "classification_policies_organization_id_not_null" CHECK("organization_id" is not null)
);
--> statement-breakpoint
ALTER TABLE `submission_inbox` ADD `label` text;