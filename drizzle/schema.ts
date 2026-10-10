import { index, int, json, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

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
