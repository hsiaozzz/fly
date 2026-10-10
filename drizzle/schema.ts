import { index, int, json, mysqlEnum, mysqlTable, primaryKey, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const projects = mysqlTable("projects", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description").notNull(),
  // Provenance survives source revocation/deletion; deliberately no foreign key.
  sourcePublicationId: varchar("sourcePublicationId", { length: 36 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => [index("projects_user_updated_idx").on(table.userId, table.updatedAt)]);

export const projectVersions = mysqlTable("project_versions", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull().references(() => projects.id, { onDelete: "cascade" }),
  version: int("version").notNull(),
  state: mysqlEnum("state", ["ready"]).default("ready").notNull(),
  artifactHash: varchar("artifactHash", { length: 64 }),
  requestId: varchar("requestId", { length: 64 }),
  requestHash: varchar("requestHash", { length: 64 }),
  gameSpec: json("gameSpec").notNull(),
  manifest: json("manifest").notNull(),
  archiveStorageKey: varchar("archiveStorageKey", { length: 720 }),
  archiveStorageUrl: varchar("archiveStorageUrl", { length: 1024 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("project_version_unique").on(table.projectId, table.version), uniqueIndex("project_request_unique").on(table.projectId, table.requestId), index("versions_project_created_idx").on(table.projectId, table.createdAt)]);

export const messages = mysqlTable("messages", {
  id: int("id").autoincrement().primaryKey(),
  projectId: int("projectId").notNull().references(() => projects.id, { onDelete: "cascade" }),
  projectVersionId: int("projectVersionId").references(() => projectVersions.id, { onDelete: "set null" }),
  role: mysqlEnum("role", ["user", "assistant", "system"]).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("messages_project_created_idx").on(table.projectId, table.createdAt)]);

export const gameFiles = mysqlTable("game_files", {
  id: int("id").autoincrement().primaryKey(),
  projectVersionId: int("projectVersionId").notNull().references(() => projectVersions.id, { onDelete: "cascade" }),
  path: varchar("path", { length: 512 }).notNull(),
  storageKey: varchar("storageKey", { length: 720 }).notNull(),
  storageUrl: varchar("storageUrl", { length: 1024 }).notNull(),
  contentType: varchar("contentType", { length: 120 }).notNull(),
  sizeBytes: int("sizeBytes").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("version_file_path_unique").on(table.projectVersionId, table.path)]);

export const builds = mysqlTable("builds", {
  id: int("id").autoincrement().primaryKey(),
  projectVersionId: int("projectVersionId").notNull().references(() => projectVersions.id, { onDelete: "cascade" }),
  status: mysqlEnum("status", ["queued", "pending", "passed", "failed"]).notNull(),
  attempts: int("attempts").notNull().default(0),
  report: json("report"),
  logStorageKey: varchar("logStorageKey", { length: 720 }),
  logStorageUrl: varchar("logStorageUrl", { length: 1024 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const storageCleanup = mysqlTable("storage_cleanup", {
  id: int("id").autoincrement().primaryKey(),
  storageKey: varchar("storageKey", { length: 720 }).notNull(),
  attempts: int("attempts").notNull().default(0),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [uniqueIndex("cleanup_key_unique").on(table.storageKey)]);

/** Published snapshots are independent of mutable draft/project state. */
export const publications = mysqlTable("publications", {
  id: varchar("id", { length: 36 }).primaryKey(),
  projectVersionId: int("projectVersionId").notNull().references(() => projectVersions.id, { onDelete: "cascade" }),
  ownerId: int("ownerId").notNull().references(() => users.id, { onDelete: "cascade" }),
  visibility: mysqlEnum("visibility", ["private", "unlisted", "public"]).notNull(),
  confirmedGameplay: int("confirmedGameplay").notNull().default(0),
  shareTokenHash: varchar("shareTokenHash", { length: 64 }),
  revokedAt: timestamp("revokedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => [index("publications_visibility_created_idx").on(table.visibility, table.createdAt)]);

// Financial records deliberately restrict user deletion rather than cascading.
export const paymentOrders = mysqlTable("payment_orders", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
  requestId: varchar("requestId", { length: 64 }).notNull(),
  packageId: varchar("packageId", { length: 40 }).notNull(),
  packageName: varchar("packageName", { length: 80 }).notNull(),
  credits: int("credits", { unsigned: true }).notNull(),
  amountFen: int("amountFen", { unsigned: true }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("CNY"),
  environment: mysqlEnum("environment", ["sandbox", "production"]).notNull(),
  appId: varchar("appId", { length: 32 }).notNull(),
  sellerId: varchar("sellerId", { length: 30 }).notNull(),
  status: mysqlEnum("status", ["pending", "paid", "closed"]).notNull().default("pending"),
  tradeNo: varchar("tradeNo", { length: 64 }),
  expiresAt: timestamp("expiresAt").notNull(),
  paidAt: timestamp("paidAt"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
}, table => [uniqueIndex("payment_order_request_unique").on(table.userId, table.environment, table.appId, table.requestId),
  uniqueIndex("payment_order_trade_unique").on(table.environment, table.appId, table.tradeNo),
  index("payment_order_user_created_idx").on(table.userId, table.createdAt)]);

export const creditAccounts = mysqlTable("credit_accounts", {
  userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
  environment: mysqlEnum("environment", ["sandbox", "production"]).notNull(),
  appId: varchar("appId", { length: 32 }).notNull(),
  available: int("available", { unsigned: true }).notNull().default(0),
  reserved: int("reserved", { unsigned: true }).notNull().default(0),
  consumed: int("consumed", { unsigned: true }).notNull().default(0),
  updatedAt: timestamp("updatedAt").notNull().defaultNow().onUpdateNow(),
}, table => [primaryKey({ columns: [table.userId, table.environment, table.appId] })]);
export const creditLedger = mysqlTable("credit_ledger", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
  environment: mysqlEnum("environment", ["sandbox", "production"]).notNull(),
  appId: varchar("appId", { length: 32 }).notNull(),
  eventKey: varchar("eventKey", { length: 128 }).notNull(),
  kind: mysqlEnum("kind", ["purchase", "reserve", "consume", "release"]).notNull(),
  referenceId: varchar("referenceId", { length: 64 }).notNull(),
  availableDelta: int("availableDelta").notNull(),
  reservedDelta: int("reservedDelta").notNull(),
  consumedDelta: int("consumedDelta").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
}, table => [uniqueIndex("credit_ledger_event_unique").on(table.eventKey), index("credit_ledger_user_created_idx").on(table.userId, table.environment, table.appId, table.createdAt)]);
export const paymentNotifications = mysqlTable("payment_notifications", {
  eventKey: varchar("eventKey", { length: 64 }).primaryKey(),
  orderId: varchar("orderId", { length: 36 }).notNull().references(() => paymentOrders.id, { onDelete: "restrict" }),
  payloadHash: varchar("payloadHash", { length: 64 }).notNull(),
  status: varchar("status", { length: 32 }).notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
});
export const generationCreditReservations = mysqlTable("generation_credit_reservations", {
  id: varchar("id", { length: 36 }).primaryKey(),
  userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
  environment: mysqlEnum("environment", ["sandbox", "production"]).notNull(),
  appId: varchar("appId", { length: 32 }).notNull(),
  taskId: varchar("taskId", { length: 64 }).notNull(),
  requestHash: varchar("requestHash", { length: 64 }).notNull(),
  state: mysqlEnum("state", ["reserved", "consumed", "released"]).notNull(),
  outcome: mysqlEnum("outcome", ["success", "failed", "aborted", "expired"]),
  expiresAt: timestamp("expiresAt").notNull(),
  settledAt: timestamp("settledAt"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
}, table => [uniqueIndex("generation_credit_task_unique").on(table.userId, table.environment, table.appId, table.taskId),
  index("generation_credit_user_expiry_idx").on(table.userId, table.environment, table.appId, table.state, table.expiresAt)]);
