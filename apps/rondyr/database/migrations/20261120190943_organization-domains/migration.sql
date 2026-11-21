CREATE TABLE `organization_domains` (
	`organization_id` text NOT NULL,
	`domain` text NOT NULL,
	CONSTRAINT `organization_domains_pk` PRIMARY KEY(`organization_id`, `domain`),
	CONSTRAINT `fk_organization_domains_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
