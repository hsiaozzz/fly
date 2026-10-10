import { describe, expect, it } from "vitest";
import { readMigrationFiles } from "drizzle-orm/migrator";
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
});
