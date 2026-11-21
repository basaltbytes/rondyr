ALTER TABLE `outbox_events` ADD `publication_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox_events` ADD `stuck_at` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `outbox_pending_idx`;--> statement-breakpoint
CREATE INDEX `outbox_due_idx` ON `outbox_events` (`lease_until`,`published_at`) WHERE "outbox_events"."handed_off_at" IS NULL AND "outbox_events"."stuck_at" IS NULL;