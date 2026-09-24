CREATE TABLE `thread_vk_session_policy_required` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`snapshot_digest` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `thread_vk_compiled_main_required` ADD `snapshot_digest` text DEFAULT '' NOT NULL;