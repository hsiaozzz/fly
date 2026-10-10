CREATE TABLE `publications` (
	`id` varchar(36) NOT NULL,
	`projectVersionId` int NOT NULL,
	`ownerId` int NOT NULL,
	`visibility` enum('private','unlisted','public') NOT NULL,
	`shareTokenHash` varchar(64),
	`revokedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `publications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `storage_cleanup` (
	`id` int AUTO_INCREMENT NOT NULL,
	`storageKey` varchar(720) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `storage_cleanup_id` PRIMARY KEY(`id`),
	CONSTRAINT `cleanup_key_unique` UNIQUE(`storageKey`)
);
--> statement-breakpoint
ALTER TABLE `builds` MODIFY COLUMN `status` enum('queued','pending','passed','failed') NOT NULL;--> statement-breakpoint
ALTER TABLE `builds` ADD `report` json;--> statement-breakpoint
ALTER TABLE `project_versions` ADD `state` enum('ready') DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE `project_versions` ADD `artifactHash` varchar(64);--> statement-breakpoint
ALTER TABLE `project_versions` ADD `requestId` varchar(64);--> statement-breakpoint
ALTER TABLE `project_versions` ADD `requestHash` varchar(64);--> statement-breakpoint
ALTER TABLE `project_versions` ADD CONSTRAINT `project_request_unique` UNIQUE(`projectId`,`requestId`);--> statement-breakpoint
ALTER TABLE `publications` ADD CONSTRAINT `publications_projectVersionId_project_versions_id_fk` FOREIGN KEY (`projectVersionId`) REFERENCES `project_versions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publications` ADD CONSTRAINT `publications_ownerId_users_id_fk` FOREIGN KEY (`ownerId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `publications_visibility_created_idx` ON `publications` (`visibility`,`createdAt`);