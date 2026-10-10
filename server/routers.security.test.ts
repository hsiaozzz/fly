import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";
import { resetGenerationLimitsForTests, generationCapacity } from "./game/access";
import { resetValidationLimitsForTests, validationCapacity } from "./game/validationAccess";
const mocked = vi.hoisted(() => ({ generate: vi.fn(), patch: vi.fn(), save: vi.fn(), verify: vi.fn(), latest: vi.fn(), validate: vi.fn(), catalog: vi.fn(), reserve: vi.fn(), settle: vi.fn() }));
vi.mock("./game/freegen", () => ({ freeGenerate: mocked.generate, freePatch: mocked.patch }));
vi.mock("./game/browserQa", () => ({ validateInBrowser: mocked.validate }));
vi.mock("./game/validationReceipt", () => ({ issueValidationReceipt: vi.fn(), verifyValidationReceipt: mocked.verify }));
vi.mock("./payments/service", () => ({ getPaymentService: () => ({ catalog: mocked.catalog, reserveGeneration: mocked.reserve, settleGeneration: mocked.settle }) }));
vi.mock("./db", () => ({ saveProjectVersion: mocked.save, latestProjectVersion: mocked.latest, createProjectForUser: vi.fn(), getProjectVersionArchive: vi.fn(), listProjectsForUser: vi.fn(), listProjectVersions: vi.fn(), loadProjectVersion: vi.fn(), publishVersion: vi.fn(), publishedVersion: vi.fn(), revokePublication: vi.fn(), explorePublications: vi.fn(), remixPublication: vi.fn() }));
import { appRouter } from "./routers";
const artifact = { title: "Test", description: "", controls: [], files: [{ path: "index.html", language: "html" as const, content: "<canvas></canvas>" }] };
function context(authenticated = false) {
  const req = Object.assign(new EventEmitter(), { ip: "router-test", headers: {}, aborted: false });
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false });
  return { req, res, ctx: { req, res, user: authenticated ? { id: 1 } : null } as unknown as TrpcContext };
}
beforeEach(() => { vi.resetAllMocks(); resetGenerationLimitsForTests(); resetValidationLimitsForTests(); mocked.verify.mockResolvedValue(false); mocked.save.mockResolvedValue({ version: 1 }); mocked.validate.mockResolvedValue({ status: "unverified" }); mocked.catalog.mockReturnValue({ configured: false }); mocked.reserve.mockResolvedValue({}); mocked.settle.mockResolvedValue({}); });
afterEach(() => vi.unstubAllEnvs());
describe("RPC security and cancellation", () => {
  it("requires authentication for persisted versions and server browser validation", async () => {
    const caller = appRouter.createCaller(context().ctx);
    await expect(caller.game.latestVersion({ projectId: 1 })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.game.validateArtifact({ artifact })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(mocked.latest).not.toHaveBeenCalled();
  });
  it("downgrades a client supplied passed build without a trusted receipt", async () => {
    await appRouter.createCaller(context(true).ctx).game.saveVersion({ projectId: 1, artifact, build: { status: "passed", attempts: 1, repairApplied: false, logs: [] } });
    expect(mocked.save).toHaveBeenCalledWith(expect.objectContaining({ build: expect.objectContaining({ status: "pending" }) }));
  });
  it("passes request cancellation to the generator and releases its lease", async () => {
    const fixture = context();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    mocked.generate.mockImplementation((_prompt, _answers, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }); started();
    }));
    const request = appRouter.createCaller(fixture.ctx).game.generate({ prompt: "Create a game" });
    const failure = expect(request).rejects.toThrow("Request cancelled");
    await ready; expect(generationCapacity().active).toBe(1); fixture.res.emit("close");
    await failure; expect(generationCapacity().active).toBe(0);
  });
  it.each(["request-aborted", "response-destroyed", "response-finished"])("does not start any expensive work when context finishes after %s", async state => {
    const fixture = context(true);
    if (state === "request-aborted") fixture.req.aborted = true;
    else fixture.res.destroyed = true;
    if (state === "response-finished") fixture.res.writableEnded = true;
    const caller = appRouter.createCaller(fixture.ctx);
    await expect(caller.game.generate({ prompt: "Create a game" })).rejects.toThrow("Request cancelled");
    await expect(caller.game.validateArtifact({ artifact })).rejects.toThrow("Request cancelled");
    await expect(caller.game.saveVersion({ projectId: 1, artifact, build: { status: "pending", attempts: 1, repairApplied: false, logs: [] } })).rejects.toThrow("Request cancelled");
    expect(mocked.generate).not.toHaveBeenCalled(); expect(mocked.validate).not.toHaveBeenCalled(); expect(mocked.save).not.toHaveBeenCalled();
    expect(generationCapacity().active).toBe(0); expect(validationCapacity().active).toBe(0);
    expect(fixture.req.listenerCount("aborted")).toBe(0); expect(fixture.res.listenerCount("close")).toBe(0);
  });
  it("rejects unsafe patch payloads before any model request", async () => {
    const caller = appRouter.createCaller(context().ctx);
    await expect(caller.game.patch({ prompt: "Fix", files: [{ ...artifact.files[0], path: "../index.html" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocked.patch).not.toHaveBeenCalled(); expect(generationCapacity().active).toBe(0);
  });
  it("validates repeatedly without consuming the user's single generation or global model token allowance", async () => {
    vi.stubEnv("GENERATION_USER_DAILY_LIMIT", "1");
    vi.stubEnv("GENERATION_GLOBAL_DAILY_TOKENS", "64000");
    const caller = appRouter.createCaller(context(true).ctx);
    for (let i = 0; i < 3; i++) await caller.game.validateArtifact({ artifact });
    expect(mocked.validate).toHaveBeenCalledTimes(3);
    await caller.game.generate({ prompt: "Create a game" });
    expect(mocked.generate).toHaveBeenCalledTimes(1);
    await expect(caller.game.generate({ prompt: "Create another game" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
  it("enforces browser concurrency and propagates cancellation without an active generation lease", async () => {
    const fixture = context(true);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    mocked.validate.mockImplementation((_artifact, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }); started();
    }));
    const caller = appRouter.createCaller(fixture.ctx);
    const first = caller.game.validateArtifact({ artifact });
    const failure = expect(first).rejects.toThrow("Request cancelled");
    await ready;
    expect(validationCapacity().active).toBe(1); expect(generationCapacity().active).toBe(0);
    await expect(caller.game.validateArtifact({ artifact })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(mocked.validate).toHaveBeenCalledTimes(1);
    fixture.res.emit("close"); await failure;
    expect(validationCapacity().active).toBe(0); expect(generationCapacity().active).toBe(0);
  });
  it("enforces browser daily limits independently of an available model allowance", async () => {
    vi.stubEnv("VALIDATION_USER_DAILY_LIMIT", "1");
    const caller = appRouter.createCaller(context(true).ctx);
    await caller.game.validateArtifact({ artifact });
    await expect(caller.game.validateArtifact({ artifact })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(mocked.validate).toHaveBeenCalledTimes(1);
    await caller.game.generate({ prompt: "Create a game" }); expect(mocked.generate).toHaveBeenCalledTimes(1);
  });
  it.each(["generate", "patch"] as const)("uses the purchased ledger for RPC %s and refunds a failed source build", async mode => {
    vi.stubEnv("GENERATION_USER_DAILY_LIMIT", "0"); mocked.catalog.mockReturnValue({ configured: true });
    const call = appRouter.createCaller(context(true).ctx).game;
    const generator = mode === "generate" ? mocked.generate : mocked.patch;
    generator.mockResolvedValueOnce({ artifact, build: { status: "pending" } }).mockResolvedValueOnce({ artifact, build: { status: "failed" } });
    const input = { prompt: "Create a game", files: artifact.files };
    await call[mode](input);
    expect(mocked.settle).toHaveBeenLastCalledWith(1, expect.any(String), "success", { signal: expect.any(AbortSignal) });
    await call[mode](input);
    expect(mocked.settle).toHaveBeenLastCalledWith(1, expect.any(String), "failed");
    expect(mocked.reserve).toHaveBeenCalledTimes(2); expect(generationCapacity().active).toBe(0);
  });
});
