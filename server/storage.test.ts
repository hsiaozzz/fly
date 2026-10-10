import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("bounded storage operations", () => {
  it("registers an object before its first network request and tracks timeout candidates", async () => {
    vi.resetModules(); vi.stubEnv("BUILT_IN_FORGE_API_URL", "https://storage.example"); vi.stubEnv("BUILT_IN_FORGE_API_KEY", "test-not-a-real-key");
    const events: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => { events.push("network"); return new Response(JSON.stringify({ url: "https://objects.example/upload" }), { status: 200 }); }));
    const { storagePut } = await import("./storage");
    const result = await storagePut("project/index.html", "test", "text/html", { onPrepared: async () => { events.push("registered"); } });
    expect(events[0]).toBe("registered"); expect(result.key).toMatch(/_[a-f0-9]{32}\.html$/);
    const calls = vi.mocked(fetch).mock.calls; expect(calls.every(call => Boolean(call[1]?.signal))).toBe(true);
  });
  it("stops reading when streamed bytes exceed the file limit", async () => {
    vi.resetModules(); vi.stubEnv("BUILT_IN_FORGE_API_URL", "https://storage.example"); vi.stubEnv("BUILT_IN_FORGE_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://objects.example/file" }))).mockResolvedValueOnce(new Response("123456")));
    const { storageReadText } = await import("./storage"); await expect(storageReadText("project/index.html", 5)).rejects.toThrow("size limit");
  });
  it("fails deletion explicitly when no deployment adapter is configured", async () => {
    vi.stubEnv("STORAGE_DELETE_URL", ""); const { storageDelete } = await import("./storage"); await expect(storageDelete("project/file")).rejects.toThrow("adapter is not configured");
  });
});
