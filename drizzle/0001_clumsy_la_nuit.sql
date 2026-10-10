CREATE TABLE `builds` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectVersionId` int NOT NULL,
	`status` enum('queued','passed','failed') NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`logStorageKey` varchar(720),
	`logStorageUrl` varchar(1024),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `builds_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `game_files` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectVersionId` int NOT NULL,
	`path` varchar(512) NOT NULL,
	`storageKey` varchar(720) NOT NULL,
	`storageUrl` varchar(1024) NOT NULL,
	`contentType` varchar(120) NOT NULL,
	`sizeBytes` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `game_files_id` PRIMARY KEY(`id`),
	CONSTRAINT `version_file_path_unique` UNIQUE(`projectVersionId`,`path`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`projectVersionId` int,
	`role` enum('user','assistant','system') NOT NULL,
	`content` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `project_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`projectId` int NOT NULL,
	`version` int NOT NULL,
	`gameSpec` json NOT NULL,
	`manifest` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `project_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `project_version_unique` UNIQUE(`projectId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(120) NOT NULL,
	`description` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `builds` ADD CONSTRAINT `builds_projectVersionId_project_versions_id_fk` FOREIGN KEY (`projectVersionId`) REFERENCES `project_versions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `game_files` ADD CONSTRAINT `game_files_projectVersionId_project_versions_id_fk` FOREIGN KEY (`projectVersionId`) REFERENCES `project_versions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `messages` ADD CONSTRAINT `messages_projectVersionId_project_versions_id_fk` FOREIGN KEY (`projectVersionId`) REFERENCES `project_versions`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `project_versions` ADD CONSTRAINT `project_versions_projectId_projects_id_fk` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `projects` ADD CONSTRAINT `projects_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `messages_project_created_idx` ON `messages` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `versions_project_created_idx` ON `project_versions` (`projectId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `projects_user_updated_idx` ON `projects` (`userId`,`updatedAt`);