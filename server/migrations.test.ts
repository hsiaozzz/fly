import { describe, expect, it } from "vitest";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("fresh database migration chain", () => {
  it("contains every journal entry, starting with users before its foreign keys", () => {
    const migrations = readMigrationFiles({ migrationsFolder: path.resolve("drizzle") });
    expect(migrations.length).toBeGreaterThanOrEqual(4);
    expect(migrations[0].sql.join("\n")).toContain("CREATE TABLE `users`");
    const combined = migrations.map(migration => migration.sql.join("\n")).join("\n");
    expect(combined).toContain("`project_request_unique`");
    expect(combined).toContain("CREATE TABLE `storage_cleanup`");
    expect(combined).toContain("CREATE TABLE `publications`");
    expect(combined).toContain("ADD `sourcePublicationId` varchar(36)");
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
    let previous = "00000000-0000-0000-0000-000000000000";
    for (const entry of journal.entries) {
      const snapshot = JSON.parse(readFileSync(`drizzle/meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`, "utf8"));
      expect(snapshot.prevId).toBe(previous); previous = snapshot.id;
    }
  });
  it.each([undefined, 2, 5])("executes only the missing migration suffix after journal entry %s", async lastIndex => {
    const migrations = readMigrationFiles({ migrationsFolder: path.resolve("drizzle") });
    const dialect = new MySqlDialect();
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const tx = { execute: async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const { sql, params } = dialect.sqlToQuery(query);
      statements.push({ sql, params });
      return [];
    } };
    const session = {
      execute: async (_query: unknown) => [],
      all: async (_query: unknown) => lastIndex === undefined ? [] : [{ id: lastIndex + 1, hash: migrations[lastIndex].hash, created_at: migrations[lastIndex].folderMillis }],
      transaction: async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx),
    };
    // Exercise the actual Drizzle MySQL migration planner without opening a
    // connection. CI owns executing these same statements against MySQL 8.
    await dialect.migrate(migrations, session as Parameters<typeof dialect.migrate>[1], {});
    const missing = migrations.slice(lastIndex === undefined ? 0 : lastIndex + 1);
    const expected = missing.flatMap(migration => [
      ...migration.sql.map(sql => ({ sql, params: [] })),
      { sql: "insert into `__drizzle_migrations` (`hash`, `created_at`) values(?, ?)", params: [migration.hash, migration.folderMillis] },
    ]);
    expect(statements).toEqual(expected);
    if (lastIndex === 2) {
      expect(statements.some(statement => statement.sql.includes("CREATE TABLE `users`"))).toBe(false);
      expect(statements.some(statement => statement.sql.includes("ADD `sourcePublicationId`"))).toBe(true);
    }
  });
});
