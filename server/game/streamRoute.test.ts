import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { HttpError } from "../../shared/_core/errors";
const mocks = vi.hoisted(() => ({ clarify: vi.fn(), generate: vi.fn(), patch: vi.fn(), authenticate: vi.fn(), revision: vi.fn() }));
vi.mock("./freegen", () => ({ clarifyRequest: mocks.clarify, freeGenerate: mocks.generate, freePatch: mocks.patch, createGenerationJobOptions: (options: unknown) => options }));
vi.mock("../_core/sdk", () => ({ sdk: { authenticateRequest: mocks.authenticate } }));
vi.mock("../db", () => ({ assertProjectRevision: mocks.revision }));
import { registerGameStreamRoute } from "./streamRoute";
import { generationCapacity, resetGenerationLimitsForTests } from "./access";
let server: Server;
let url: string;
beforeEach(async () => {
  vi.clearAllMocks(); resetGenerationLimitsForTests();
  mocks.authenticate.mockRejectedValue(new HttpError(401, "No session"));
  mocks.clarify.mockResolvedValue({ decision: { needClarification: false, intent: "fixture", questions: [] } });
  const app = express(); app.use(express.json()); registerGameStreamRoute(app);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/game/stream`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
describe("game stream orchestration", () => {
  it("rejects malformed patch files before opening SSE or charging a lease", async () => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "patch", prompt: "change", existing: [{ path: "../unsafe", content: "x" }] }) });
    expect(response.status).toBe(400); expect(mocks.patch).not.toHaveBeenCalled(); expect(generationCapacity().active).toBe(0);
  });
  it("emits live stages and binds the final response to the requested revision context", async () => {
    mocks.generate.mockImplementation(async (_prompt, _answers, options) => { options.onStage({ agent: "Creator", status: "running", detail: "working" }); return { artifact: { title: "fixture" } }; });
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "make a game", runId: "run-fixture" }) });
    const text = await response.text();
    expect(text).toContain('"status":"running"'); expect(text).toContain('"runId":"run-fixture"'); expect(text).toContain("event: complete");
    expect(mocks.clarify).toHaveBeenCalledTimes(1); expect(generationCapacity().active).toBe(0);
  });
  it("propagates client disconnect to generation and frees shared concurrency", async () => {
    let signal: AbortSignal | undefined;
    mocks.generate.mockImplementation((_prompt, _answers, options) => {
      signal = options.signal;
      options.onStage({ agent: "Creator", status: "running", detail: "working" });
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    const controller = new AbortController();
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "make a game" }), signal: controller.signal });
    await response.body!.getReader().read(); controller.abort();
    for (let i = 0; i < 100 && generationCapacity().active; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(signal?.aborted).toBe(true); expect(generationCapacity().active).toBe(0);
  });
});
