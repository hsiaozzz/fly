import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { persistVersion, type VersionBackend, type PreparedVersion, type VersionResult, type SaveVersionInput } from "./versionPersistence";
import type { GameArtifact } from "../shared/game/types";

const artifact: GameArtifact = { title: "Test", description: "snapshot", controls: ["Space"], files: [{ path: "index.html", language: "html", content: "<canvas></canvas>" }] };
const input = (overrides: Partial<SaveVersionInput> = {}): SaveVersionInput => ({ userId: 1, projectId: 1, artifact, build: { status: "pending", attempts: 1, repairApplied: false, logs: [] }, ...overrides });
function backend(options: { failUpload?: number; failCommit?: boolean; deny?: boolean } = {}) {
  const objects = new Map<string, string | Buffer>();
  const cleanup: string[][] = [];
  const versions: Array<{ prepared: PreparedVersion; result: VersionResult }> = [];
  let attempts = 0;
  let queue = Promise.resolve();
  const store: VersionBackend = {
    authorize: async () => { if (options.deny) throw new Error("denied"); },
    replay: async (value, hash) => {
      const previous = value.requestId ? versions.find(version => version.prepared.input.requestId === value.requestId) : undefined;
      if (previous && previous.prepared.requestHash !== hash) throw new Error("request conflict");
      return previous?.result ?? null;
    },
    upload: async (key, content, _type, onPrepared) => {
      const stored = `${key}_${++attempts}`; onPrepared(stored); objects.set(stored, content);
      if (attempts === options.failUpload) throw new Error("upload timed out after accepting bytes");
      return { key: stored, url: `/manus-storage/${stored}` };
    },
    commit: prepared => {
      // The production backend uses a database parent-row lock. This fixture
      // models serialized commits so competing uploads can complete in parallel.
      const pending = queue.then(() => {
        if (options.failCommit) throw new Error("database failed");
        const existing = prepared.input.requestId ? versions.find(version => version.prepared.input.requestId === prepared.input.requestId) : undefined;
        if (existing) {
          if (existing.prepared.requestHash !== prepared.requestHash) throw new Error("request conflict");
          return { result: existing.result, replay: true };
        }
        if (prepared.input.baseVersionId !== undefined && prepared.input.baseVersionId !== (versions.at(-1)?.result.projectVersionId ?? null)) throw new Error("revision conflict");
        const number = versions.length + 1;
        const result: VersionResult = { projectVersionId: number, version: number, manifest: prepared.manifest, artifactHash: prepared.artifactHash, state: "ready" };
        versions.push({ prepared, result }); return { result, replay: false };
      });
      queue = pending.then(() => undefined, () => undefined); return pending;
    },
    cleanup: async keys => { cleanup.push(keys); keys.forEach(key => objects.delete(key)); },
  };
  return { store, objects, cleanup, versions, get attempts() { return attempts; } };
}

describe("immutable version persistence", () => {
  it("rejects unauthorized and unsafe files before uploading", async () => {
    const denied = backend({ deny: true });
    await expect(persistVersion(input(), denied.store)).rejects.toThrow("denied");
    expect(denied.objects.size).toBe(0);
    const invalid = backend();
    await expect(persistVersion(input({ artifact: { ...artifact, files: [{ ...artifact.files[0], path: "../index.html" }] } }), invalid.store)).rejects.toThrow();
    expect(invalid.attempts).toBe(0);
  });
  it("cancels a disconnected save and compensates already uploaded objects", async () => {
    const fixture = backend(); const controller = new AbortController();
    const originalUpload = fixture.store.upload;
    fixture.store.upload = async (...args) => { const stored = await originalUpload(...args); controller.abort(new DOMException("cancelled", "AbortError")); return stored; };
    await expect(persistVersion(input({ signal: controller.signal }), fixture.store)).rejects.toThrow("cancelled");
    expect(fixture.versions).toHaveLength(0); expect(fixture.objects.size).toBe(0); expect(fixture.cleanup[0]).toHaveLength(1);
  });
  it("writes a complete archive and hashes actual UTF-8 file bytes", async () => {
    const fixture = backend(); const result = await persistVersion(input(), fixture.store);
    const zipBytes = [...fixture.objects.values()].find(value => Buffer.isBuffer(value))!;
    const zip = await JSZip.loadAsync(zipBytes);
    expect(await zip.file("index.html")!.async("string")).toBe(artifact.files[0].content);
    expect(zip.file("__arcane__/play.html")).not.toBeNull();
    expect(JSON.parse(await zip.file("__arcane__/artifact.json")!.async("string")).files[0].content).toBe(artifact.files[0].content);
    expect(result.manifest[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.state).toBe("ready"); expect(fixture.versions).toHaveLength(1);
  });
  it("compensates every attempted object when a PUT times out", async () => {
    const fixture = backend({ failUpload: 2 });
    await expect(persistVersion(input(), fixture.store)).rejects.toThrow("timed out");
    expect(fixture.cleanup[0]).toHaveLength(2); expect(fixture.objects.size).toBe(0); expect(fixture.versions).toHaveLength(0);
  });
  it("does not expose a version when its database commit fails", async () => {
    const fixture = backend({ failCommit: true });
    await expect(persistVersion(input(), fixture.store)).rejects.toThrow("database failed");
    expect(fixture.objects.size).toBe(0); expect(fixture.versions).toHaveLength(0);
  });
  it("serializes concurrent saves and rejects a stale base snapshot", async () => {
    const fixture = backend();
    const results = await Promise.all([persistVersion(input(), fixture.store), persistVersion(input(), fixture.store)]);
    expect(results.map(value => value.version).sort()).toEqual([1, 2]);
    await expect(persistVersion(input({ baseVersionId: null }), fixture.store)).rejects.toThrow("revision conflict");
    expect(fixture.versions).toHaveLength(2); expect(fixture.objects.size).toBe(6);
  });
  it("replays one request once, cleans racing uploads, and rejects changed content", async () => {
    const fixture = backend(); const request = input({ requestId: "request-a", baseVersionId: null });
    const results = await Promise.all([persistVersion(request, fixture.store), persistVersion(request, fixture.store)]);
    expect(results[0].projectVersionId).toBe(results[1].projectVersionId);
    expect(fixture.versions).toHaveLength(1); expect(fixture.objects.size).toBe(3);
    const count = fixture.attempts; await persistVersion(request, fixture.store); expect(fixture.attempts).toBe(count);
    await expect(persistVersion({ ...request, artifact: { ...artifact, title: "Changed" } }, fixture.store)).rejects.toThrow("request conflict");
  });
});
