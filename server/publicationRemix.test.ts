import { afterEach, describe, expect, it, vi } from "vitest";
import { builds, gameFiles, projects, projectVersions } from "../drizzle/schema";
import { artifactDigest } from "../shared/game/artifact";
import type { GameArtifact } from "../shared/game/types";
import { createRemixArtifact } from "./publicationRemix";
import { sha256 } from "./versionPersistence";

const mocked = vi.hoisted(() => ({ db: undefined as unknown, objects: new Map<string, string>(), sequence: 0 }));
vi.mock("drizzle-orm/mysql2", () => ({ drizzle: () => mocked.db }));
vi.mock("./storage", () => ({
  storagePut: async (key: string, content: string | Buffer, _type: string, options: { onPrepared?: (key: string) => Promise<void> }) => {
    const storageKey = `${key}_${++mocked.sequence}`;
    await options?.onPrepared?.(storageKey);
    mocked.objects.set(storageKey, typeof content === "string" ? content : content.toString("utf8"));
    return { key: storageKey, url: `/manus-storage/${storageKey}` };
  },
  storageReadText: async (key: string) => { if (!mocked.objects.has(key)) throw new Error("Missing mocked object."); return mocked.objects.get(key)!; },
  storageDelete: async (key: string) => { mocked.objects.delete(key); },
}));

const sourceId = "019bff99-6cee-7000-8000-000000000001";
const artifact: GameArtifact = { title: "Original", description: "A published game", controls: ["Space"], files: [{ path: "index.html", language: "html", content: "<canvas></canvas>" }] };
afterEach(() => { vi.unstubAllEnvs(); mocked.objects.clear(); });

describe("remix snapshot identity and durable provenance", () => {
  it("clones original files and controls, changes the hash, and retains the remix suffix for long titles", async () => {
    const source = structuredClone(artifact); const remix = createRemixArtifact(source);
    expect(remix.title).toBe("Original remix");
    expect(remix.files).toEqual(source.files); expect(remix.controls).toEqual(source.controls);
    expect(await artifactDigest(remix)).not.toBe(await artifactDigest(source));
    remix.files[0].content = "edited"; remix.controls.push("Enter");
    expect(source).toEqual(artifact);
    const long = createRemixArtifact({ ...artifact, title: "x".repeat(120) });
    expect(long.title).toHaveLength(120); expect(long.title.endsWith(" remix")).toBe(true);
    const repeated = createRemixArtifact({ ...artifact, title: long.title });
    expect(repeated.title).not.toBe(long.title); expect(repeated.title).toHaveLength(120);
  });

  it("persists source identity separately from descriptions across the actual save transaction", async () => {
    vi.stubEnv("DATABASE_URL", "mysql://mock-only/no-connection");
    const service = await import("./db");
    const projectState: Record<string, unknown> = {};
    const inserts: Array<{ table: unknown; values: unknown }> = [];
    const selects: unknown[][] = [];
    let nextVersionId = 10;
    const fakeDb = {
      select: () => {
        // Scripted query results exercise the production orchestration without
        // pretending to implement SQL locking, which the gated MySQL test owns.
        const chain = {
          from: (_table: unknown) => chain,
          innerJoin: (_table: unknown, _predicate: unknown) => chain,
          where: (_predicate: unknown) => chain,
          orderBy: (_order: unknown) => chain,
          limit: (_limit: number) => chain,
          for: (_lock: string) => chain,
          then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => {
            const rows = selects.shift();
            return rows ? Promise.resolve(rows).then(resolve, reject) : Promise.reject(new Error("Unexpected database query.")).then(resolve, reject);
          },
        };
        return chain;
      },
      insert: (table: unknown) => ({ values: async (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        if (table === projects) Object.assign(projectState, { id: 2, ...values });
        return [{ insertId: table === projects ? 2 : table === projectVersions ? ++nextVersionId : 1 }];
      } }),
      update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async (_predicate: unknown) => { if (table === projects) Object.assign(projectState, values); } }) }),
      delete: (_table: unknown) => ({ where: async (_predicate: unknown) => undefined }),
      transaction: async <T>(callback: (tx: unknown) => Promise<T>) => callback(fakeDb),
      $client: { promise: () => ({ end: async () => undefined }) },
    };
    mocked.db = fakeDb;
    mocked.objects.set("original/index.html", artifact.files[0].content);
    const originalVersion = { id: 1, version: 1, projectId: 1, state: "ready", artifactHash: await artifactDigest(artifact), gameSpec: { title: artifact.title, description: artifact.description, controls: artifact.controls }, manifest: [{ path: "index.html", language: "html", sha256: sha256(artifact.files[0].content) }] };
    const newProject = { id: 2, userId: 2, name: "Original remix", description: artifact.description, sourcePublicationId: sourceId };
    selects.push(
      [{ publication: { id: sourceId, ownerId: 1, visibility: "public", revokedAt: null, confirmedGameplay: 1 }, version: originalVersion }],
      [{ projectVersionId: 1, path: "index.html", storageKey: "original/index.html", sizeBytes: Buffer.byteLength(artifact.files[0].content) }],
      [], // original build metadata
      [newProject], // creation reads the new project
      [newProject], // ownership guard
      [newProject], // parent-row lock
      [], // no previous version in the new project
    );
    try {
      const remix = await service.remixPublication(2, sourceId);
      expect(remix.project).toMatchObject(newProject);
      expect(remix.version.artifactHash).not.toBe(originalVersion.artifactHash);
      expect(projectState).toMatchObject(newProject);
      const first = inserts.find(item => item.table === projectVersions)!.values;
      expect(first).toMatchObject({ gameSpec: { title: "Original remix", description: artifact.description } });
      expect(inserts.find(item => item.table === builds)!.values).toMatchObject({ status: "pending" });
      expect(inserts.find(item => item.table === gameFiles)!.values).toEqual(expect.arrayContaining([expect.objectContaining({ path: "index.html" })]));

      selects.push([projectState], [projectState], [{ id: remix.version.projectVersionId, version: 1 }]);
      await service.saveProjectVersion({ userId: 2, projectId: 2, artifact: { ...createRemixArtifact(artifact), title: "Renamed", description: "Edited description" }, build: { status: "pending", attempts: 1, repairApplied: false, logs: [] }, baseVersionId: remix.version.projectVersionId });
      expect(projectState).toMatchObject({ sourcePublicationId: sourceId, name: "Renamed", description: "Edited description" });
      expect(selects).toHaveLength(0);
      expect(mocked.objects.get("original/index.html")).toBe(artifact.files[0].content);
    } finally { await service.closeDb(); }
  });
});
