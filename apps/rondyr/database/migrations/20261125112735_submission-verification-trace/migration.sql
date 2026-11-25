CREATE TABLE `submission_events` (
	`submission_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `submission_events_pk` PRIMARY KEY(`submission_id`, `seq`),
	CONSTRAINT `fk_submission_events_submission_id_submissions_id_fk` FOREIGN KEY (`submission_id`) REFERENCES `submissions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `intake_trace` text;--> statement-breakpoint
ALTER TABLE `submissions` ADD `intake_checks` text;