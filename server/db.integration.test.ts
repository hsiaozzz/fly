import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";
import { projects, projectVersions, users, storageCleanup, publications } from "../drizzle/schema";
import type { GameArtifact } from "../shared/game/types";
const fakeObjects = vi.hoisted(() => ({ files: new Map<string, string>(), sequence: 0 }));
vi.mock("./storage", () => ({
  storagePut: async (key: string, content: string | Buffer, _type: string, options: { onPrepared?: (key: string) => Promise<void> }) => {
    const storageKey = `${key}_${++fakeObjects.sequence}`; await options?.onPrepared?.(storageKey);
    fakeObjects.files.set(storageKey, typeof content === "string" ? content : content.toString("utf8")); return { key: storageKey, url: `/manus-storage/${storageKey}` };
  },
  storageDelete: async (key: string) => { fakeObjects.files.delete(key); },
  storageReadText: async (key: string) => { if (!fakeObjects.files.has(key)) throw new Error("missing test file"); return fakeObjects.files.get(key)!; },
}));

// Only a deliberately configured disposable test database is used. Normal test
// runs neither connect to DATABASE_URL nor read deployment credentials.
describe.runIf(Boolean(process.env.ARCANE_TEST_DATABASE_URL))("MySQL version transactions and object ownership", () => {
  let service: typeof import("./db");
  let db: NonNullable<Awaited<ReturnType<typeof import("./db").getDb>>>;
  let ownerId: number;
  let strangerId: number;
  let projectId: number;
  const artifact: GameArtifact = { title: "Integration", description: "", controls: [], files: [{ path: "index.html", language: "html", content: "<canvas></canvas>" }] };
  const build = { status: "pending" as const, attempts: 1, repairApplied: false, logs: [] };
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", process.env.ARCANE_TEST_DATABASE_URL!);
    vi.stubEnv("JWT_SECRET", "test-only-long-random-value-1234567890");
    vi.stubEnv("VITE_APP_ID", "integration-test");
    service = await import("./db"); db = (await service.getDb())!;
    await service.checkDatabaseReadiness();
    const suffix = crypto.randomUUID();
    await service.upsertUser({ openId: `test-owner-${suffix}`, role: "admin" });
    await service.upsertUser({ openId: `test-stranger-${suffix}` });
    ownerId = (await service.getUserByOpenId(`test-owner-${suffix}`))!.id;
    strangerId = (await service.getUserByOpenId(`test-stranger-${suffix}`))!.id;
    projectId = (await service.createProjectForUser(ownerId, "Integration", "Disposable CI fixture")).id;
  });
  afterAll(async () => {
    try {
      if (db) {
        if (projectId) await db.delete(projects).where(eq(projects.id, projectId));
        if (ownerId) await db.delete(users).where(eq(users.id, ownerId));
        if (strangerId) await db.delete(users).where(eq(users.id, strangerId));
        for (const key of fakeObjects.files.keys()) await db.delete(storageCleanup).where(eq(storageCleanup.storageKey, key));
      }
    } finally { await service?.closeDb(); vi.unstubAllEnvs(); }
  });
  it("replays migrations without changing the journal and keeps an explicitly granted admin role", async () => {
    const migrations = readMigrationFiles({ migrationsFolder: path.resolve("drizzle") });
    const [before] = await db.$client.promise().query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at");
    expect(before).toEqual(migrations.map(migration => ({ hash: migration.hash, created_at: migration.folderMillis })));
    await migrate(db, { migrationsFolder: path.resolve("drizzle") });
    const [after] = await db.$client.promise().query("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at");
    expect(after).toEqual(before);
    const user = (await db.select().from(users).where(eq(users.id, ownerId)))[0];
    await service.upsertUser({ openId: user.openId, lastSignedIn: new Date() });
    expect((await service.getUserByOpenId(user.openId))!.role).toBe("admin");
  });
  it("locks concurrent commits and replays duplicate requests once", async () => {
    const request = { userId: ownerId, projectId, artifact, build };
    const first = await Promise.all([service.saveProjectVersion(request), service.saveProjectVersion(request)]);
    expect(first.map(item => item.version).sort()).toEqual([1, 2]);
    const latest = await service.latestProjectVersion(ownerId, projectId);
    const duplicate = { ...request, baseVersionId: latest!.version.id, requestId: crypto.randomUUID() };
    const results = await Promise.all([service.saveProjectVersion(duplicate), service.saveProjectVersion(duplicate)]);
    expect(results[0].projectVersionId).toBe(results[1].projectVersionId);
    const rows = await db.select().from(projectVersions).where(eq(projectVersions.projectId, projectId)); expect(rows).toHaveLength(3);
    expect(fakeObjects.files.size).toBe(9);
  });
  it("prevents stale commits and denies ownership even when the object key is known", async () => {
    await expect(service.saveProjectVersion({ userId: ownerId, projectId, artifact, build, baseVersionId: null })).rejects.toMatchObject({ code: "CONFLICT" });
    const key = [...fakeObjects.files.keys()].find(key => key.includes("index.html"))!;
    expect(await service.canReadStorageObject(ownerId, key)).toBe(true);
    expect(await service.canReadStorageObject(strangerId, key)).toBe(false);
    await expect(service.latestProjectVersion(strangerId, projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const history = await service.listProjectVersions(ownerId, projectId, { limit: 1 });
    expect(history.items).toHaveLength(1); expect(history.nextCursor).toBeTruthy(); expect(history.items[0]).not.toHaveProperty("gameSpec");
    expect(fakeObjects.files.size).toBe(9);
  });
  it("publishes only a receipt-bound immutable snapshot and enforces/revokes share access", async () => {
    const { issueValidationReceipt } = await import("./game/validationReceipt");
    const { artifactDigest } = await import("../shared/game/artifact");
    const latest = (await service.latestProjectVersion(ownerId, projectId))!;
    const receipt = await issueValidationReceipt(latest.artifact, { schemaVersion: 1, artifactHash: await artifactDigest(latest.artifact), status: "passed", checks: [], errors: [], durationMs: 1, testedAt: new Date().toISOString(), environment: { runner: "playwright", viewport: { width: 800, height: 600 }, seed: 1 } });
    await expect(service.publishVersion(ownerId, latest.version.id, "public", "invalid", true)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(service.publishVersion(ownerId, latest.version.id, "public", receipt!, false)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const publication = await service.publishVersion(ownerId, latest.version.id, "unlisted", receipt!, true);
    await expect(service.publishedVersion(publication.publicationId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const allowed = await service.publishedVersion(publication.publicationId, undefined, publication.shareToken);
    expect(allowed.version.id).toBe(latest.version.id); expect(allowed.publication.confirmedGameplay).toBe(true);
    expect((await service.explorePublications()).items.some(item => item.publicationId === publication.publicationId)).toBe(false);
    const remix = await service.remixPublication(strangerId, publication.publicationId, publication.shareToken);
    let derived = (await db.select().from(projects).where(eq(projects.id, remix.project.id)))[0];
    expect(derived).toMatchObject({ name: "Integration remix", sourcePublicationId: publication.publicationId });
    const remixed = (await service.latestProjectVersion(strangerId, remix.project.id))!;
    expect(remixed.artifact.files).toEqual(latest.artifact.files);
    expect(remixed.version.artifactHash).not.toBe(latest.version.artifactHash);
    await expect(service.publishVersion(strangerId, remixed.version.id, "public", receipt!, true)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await service.saveProjectVersion({ userId: strangerId, projectId: remix.project.id, artifact: { ...remixed.artifact, title: "New identity", description: "Edited description" }, build, baseVersionId: remixed.version.id });
    await service.revokePublication(ownerId, publication.publicationId);
    await expect(service.publishedVersion(publication.publicationId, undefined, publication.shareToken)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.delete(publications).where(eq(publications.id, publication.publicationId));
    derived = (await db.select().from(projects).where(eq(projects.id, remix.project.id)))[0];
    expect(derived).toMatchObject({ name: "New identity", description: "Edited description", sourcePublicationId: publication.publicationId });
    expect((await service.latestProjectVersion(strangerId, remix.project.id))!.artifact.title).toBe("New identity");
    await db.delete(projects).where(eq(projects.id, remix.project.id));
  });

});
