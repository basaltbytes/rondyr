ALTER TABLE `submissions` ADD `sender_fingerprint` text;--> statement-breakpoint
ALTER TABLE `submissions` ADD `content_fingerprint` text;--> statement-breakpoint
ALTER TABLE `submissions` ADD `prior_same_sender` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `submissions` ADD `prior_same_content` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `submissions_sender_repetition_idx` ON `submissions` (`organization_id`,`sender_fingerprint`,`received_at`) WHERE "submissions"."sender_fingerprint" is not null;--> statement-breakpoint
CREATE INDEX `submissions_content_repetition_idx` ON `submissions` (`organization_id`,`content_fingerprint`,`received_at`) WHERE "submissions"."content_fingerprint" is not null;