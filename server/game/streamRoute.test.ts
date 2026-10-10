import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { HttpError } from "../../shared/_core/errors";
const mocks = vi.hoisted(() => ({ clarify: vi.fn(), generate: vi.fn(), patch: vi.fn(), authenticate: vi.fn(), revision: vi.fn(), catalog: vi.fn(), reserve: vi.fn(), settle: vi.fn() }));
vi.mock("./freegen", () => ({ clarifyRequest: mocks.clarify, freeGenerate: mocks.generate, freePatch: mocks.patch, createGenerationJobOptions: (options: unknown) => options }));
vi.mock("../_core/sdk", () => ({ sdk: { authenticateRequest: mocks.authenticate } }));
vi.mock("../db", () => ({ assertProjectRevision: mocks.revision }));
vi.mock("../payments/service", () => ({ getPaymentService: () => ({ catalog: mocks.catalog, reserveGeneration: mocks.reserve, settleGeneration: mocks.settle }) }));
import { registerGameStreamRoute } from "./streamRoute";
import { generationCapacity, resetGenerationLimitsForTests } from "./access";
let server: Server;
let url: string;
beforeEach(async () => {
  vi.clearAllMocks(); resetGenerationLimitsForTests();
  mocks.authenticate.mockRejectedValue(new HttpError(401, "No session"));
  mocks.catalog.mockReturnValue({ configured: false }); mocks.reserve.mockResolvedValue({}); mocks.settle.mockResolvedValue({});
  mocks.clarify.mockResolvedValue({ decision: { needClarification: false, intent: "fixture", questions: [] } });
  const app = express(); app.use(express.json()); registerGameStreamRoute(app);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/game/stream`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); });
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
  it.each(["free", "purchased"])("propagates client disconnect for %s generation and frees shared concurrency", async admission => {
    if (admission === "purchased") {
      vi.stubEnv("GENERATION_USER_DAILY_LIMIT", "0"); mocks.authenticate.mockResolvedValue({ id: 7 }); mocks.catalog.mockReturnValue({ configured: true });
    }
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
    if (admission === "purchased") {
      expect(mocks.reserve).toHaveBeenCalledTimes(1); expect(mocks.settle).toHaveBeenCalledWith(7, expect.any(String), "aborted");
    }
  });
  it.each(["success", "failed-build", "clarify", "error"])("settles purchased SSE generation correctly for %s", async scenario => {
    vi.stubEnv("GENERATION_USER_DAILY_LIMIT", "0"); mocks.authenticate.mockResolvedValue({ id: 7 }); mocks.catalog.mockReturnValue({ configured: true });
    if (scenario === "clarify") mocks.clarify.mockResolvedValue({ decision: { needClarification: true, intent: "fixture", questions: [] } });
    else if (scenario === "error") mocks.generate.mockRejectedValue(new Error("fixture failure"));
    else mocks.generate.mockResolvedValue({ artifact: { title: "fixture" }, build: { status: scenario === "failed-build" ? "failed" : "pending" } });
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "make a game" }) });
    const output = await response.text();
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    if (scenario === "success") expect(mocks.settle).toHaveBeenCalledWith(7, expect.any(String), "success", { signal: expect.any(AbortSignal) });
    else expect(mocks.settle).toHaveBeenCalledWith(7, expect.any(String), "failed");
    expect(mocks.settle).toHaveBeenCalledTimes(1); expect(generationCapacity().active).toBe(0);
    expect(output).toContain(`event: ${scenario === "clarify" ? "clarify" : scenario === "error" ? "error" : "complete"}`);
  });
  it("withholds completion when a purchased success cannot be committed", async () => {
    vi.stubEnv("GENERATION_USER_DAILY_LIMIT", "0"); mocks.authenticate.mockResolvedValue({ id: 7 }); mocks.catalog.mockReturnValue({ configured: true });
    mocks.generate.mockResolvedValue({ artifact: { title: "fixture" }, build: { status: "pending" } });
    mocks.settle.mockRejectedValueOnce(new Error("account unavailable"));
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "make a game" }) });
    const output = await response.text(); expect(output).not.toContain("event: complete"); expect(output).toContain("event: error");
    expect(mocks.settle).toHaveBeenLastCalledWith(7, expect.any(String), "failed"); expect(generationCapacity().active).toBe(0);
  });
});
