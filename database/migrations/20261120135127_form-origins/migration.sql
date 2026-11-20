CREATE TABLE `form_origins` (
	`form_id` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `form_origins_pk` PRIMARY KEY(`form_id`, `origin`),
	CONSTRAINT `fk_form_origins_form_id_forms_id_fk` FOREIGN KEY (`form_id`) REFERENCES `forms`(`id`) ON DELETE CASCADE
);
