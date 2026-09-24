CREATE TABLE `thread_vk_compiled_main_required` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`source_hash` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
