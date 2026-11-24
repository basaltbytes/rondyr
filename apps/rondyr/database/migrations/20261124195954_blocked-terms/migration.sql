CREATE TABLE `form_blocked_terms` (
	`form_id` text NOT NULL,
	`term` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `form_blocked_terms_pk` PRIMARY KEY(`form_id`, `term`),
	CONSTRAINT `fk_form_blocked_terms_form_id_forms_id_fk` FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `organization_blocked_terms` (
	`organization_id` text NOT NULL,
	`term` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `organization_blocked_terms_pk` PRIMARY KEY(`organization_id`, `term`),
	CONSTRAINT `fk_organization_blocked_terms_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
