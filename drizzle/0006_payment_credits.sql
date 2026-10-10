CREATE TABLE `credit_accounts` (
	`userId` int NOT NULL,
	`environment` enum('sandbox','production') NOT NULL,
	`appId` varchar(32) NOT NULL,
	`available` int unsigned NOT NULL DEFAULT 0,
	`reserved` int unsigned NOT NULL DEFAULT 0,
	`consumed` int unsigned NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `credit_accounts_userId_environment_appId_pk` PRIMARY KEY(`userId`,`environment`,`appId`)
);
--> statement-breakpoint
CREATE TABLE `credit_ledger` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`environment` enum('sandbox','production') NOT NULL,
	`appId` varchar(32) NOT NULL,
	`eventKey` varchar(128) NOT NULL,
	`kind` enum('purchase','reserve','consume','release') NOT NULL,
	`referenceId` varchar(64) NOT NULL,
	`availableDelta` int NOT NULL,
	`reservedDelta` int NOT NULL,
	`consumedDelta` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `credit_ledger_id` PRIMARY KEY(`id`),
	CONSTRAINT `credit_ledger_event_unique` UNIQUE(`eventKey`)
);
--> statement-breakpoint
CREATE TABLE `generation_credit_reservations` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`environment` enum('sandbox','production') NOT NULL,
	`appId` varchar(32) NOT NULL,
	`taskId` varchar(64) NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`state` enum('reserved','consumed','released') NOT NULL,
	`outcome` enum('success','failed','aborted','expired'),
	`expiresAt` timestamp NOT NULL,
	`settledAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `generation_credit_reservations_id` PRIMARY KEY(`id`),
	CONSTRAINT `generation_credit_task_unique` UNIQUE(`userId`,`environment`,`appId`,`taskId`)
);
--> statement-breakpoint
CREATE TABLE `payment_notifications` (
	`eventKey` varchar(64) NOT NULL,
	`orderId` varchar(36) NOT NULL,
	`payloadHash` varchar(64) NOT NULL,
	`status` varchar(32) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `payment_notifications_eventKey` PRIMARY KEY(`eventKey`)
);
--> statement-breakpoint
CREATE TABLE `payment_orders` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`requestId` varchar(64) NOT NULL,
	`packageId` varchar(40) NOT NULL,
	`packageName` varchar(80) NOT NULL,
	`credits` int unsigned NOT NULL,
	`amountFen` int unsigned NOT NULL,
	`currency` varchar(3) NOT NULL DEFAULT 'CNY',
	`environment` enum('sandbox','production') NOT NULL,
	`appId` varchar(32) NOT NULL,
	`sellerId` varchar(30) NOT NULL,
	`status` enum('pending','paid','closed') NOT NULL DEFAULT 'pending',
	`tradeNo` varchar(64),
	`expiresAt` timestamp NOT NULL,
	`paidAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payment_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_order_request_unique` UNIQUE(`userId`,`environment`,`appId`,`requestId`),
	CONSTRAINT `payment_order_trade_unique` UNIQUE(`environment`,`appId`,`tradeNo`)
);
--> statement-breakpoint
ALTER TABLE `credit_accounts` ADD CONSTRAINT `credit_accounts_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `credit_ledger` ADD CONSTRAINT `credit_ledger_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `generation_credit_reservations` ADD CONSTRAINT `generation_credit_reservations_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_notifications` ADD CONSTRAINT `payment_notifications_orderId_payment_orders_id_fk` FOREIGN KEY (`orderId`) REFERENCES `payment_orders`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_orders` ADD CONSTRAINT `payment_orders_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `credit_ledger_user_created_idx` ON `credit_ledger` (`userId`,`environment`,`appId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `generation_credit_user_expiry_idx` ON `generation_credit_reservations` (`userId`,`environment`,`appId`,`state`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `payment_order_user_created_idx` ON `payment_orders` (`userId`,`createdAt`);