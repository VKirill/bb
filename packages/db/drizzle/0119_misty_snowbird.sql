CREATE TABLE `thread_caller_launches` (
	`origin_plugin_id` text NOT NULL,
	`caller_launch_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`binding_json` text NOT NULL,
	PRIMARY KEY(`origin_plugin_id`, `caller_launch_id`),
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thread_caller_launches_thread_id_idx` ON `thread_caller_launches` (`thread_id`);