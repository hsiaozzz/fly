import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameArtifact, TraceStep } from "../../shared/game/types";
import { artifactDigest } from "../../shared/game/artifact";
import { BROWSER_GAME_RUNTIME_JS } from "../../shared/game/browserRuntime";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../_core/llm", () => ({ invokeLLM: invoke }));
import { applyGamePatch, clarifyRequest, createGenerationJobOptions, freeGenerate, freePatch, parseJsonObject } from "./freegen";

const game = (content = `<button id="score">0</button><script>let score=0;document.querySelector('#score').addEventListener('click',()=>{document.querySelector('#score').textContent=++score});</script>`): GameArtifact => ({ title: "Click Game", description: "点击计分", controls: ["点击"], files: [{ path: "index.html", content: `<!doctype html><html><head><style>body{width:100vw}</style></head><body>${content}</body></html>`, language: "html" }] });
const response = (payload: unknown, reason = "stop") => ({ choices: [{ message: { content: typeof payload === "string" ? payload : JSON.stringify(payload) }, finish_reason: reason }], usage: { total_tokens: 42 } });

beforeEach(() => { invoke.mockReset(); vi.unstubAllEnvs(); });

describe("free-form generation", () => {
  it("retries malformed JSON and records live progress and actual token usage", async () => {
    const stages: TraceStep[] = [], usage: number[] = [];
    invoke.mockImplementationOnce(async () => { expect(stages.some(step => step.agent === "Game Creator" && step.status === "running")).toBe(true); return response("{bad json"); });
    invoke.mockResolvedValueOnce(response(game()));
    const result = await freeGenerate("做一个点击计分的小游戏", undefined, { onStage: step => stages.push(step), onUsage: tokens => usage.push(tokens) });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.build.status).toBe("pending");
    expect(result.validation?.failures).toEqual([]);
    expect(usage).toEqual([42, 42]);
    expect(result.artifact.files.find(file => file.path === "arcane.design.json")).toBeTruthy();
    expect(stages).toEqual(result.trace);
    expect(invoke.mock.calls.every(([args]) => args.maxRetries === 0)).toBe(true);
  });

  it("rejects length-truncated output even when it happens to contain valid JSON", async () => {
    invoke.mockResolvedValueOnce(response(game(), "length")).mockResolvedValueOnce(response(game()));
    const result = await freeGenerate("做一个点击计分游戏");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.trace.some(step => step.detail.includes("截断"))).toBe(true);
  });

  it("does not sanitize away invalid model files before validating", async () => {
    const bad = game(); bad.files.push({ path: "../escape.js", content: "", language: "text" });
    invoke.mockResolvedValue(response(bad));
    await expect(freeGenerate("做一个点击游戏")).rejects.toThrow("产物校验");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("sends actual current candidate code to the repair model", async () => {
    const initial = game("<canvas id='candidate-marker'></canvas><script>const unfinished = ;</script>");
    invoke.mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response(game()));
    const result = await freeGenerate("做一个点击计分游戏");
    const repairPrompt = invoke.mock.calls[1][0].messages[1].content;
    expect(repairPrompt).toContain("candidate-marker");
    expect(repairPrompt).toContain("Current candidate to repair");
    expect(result.validation?.failures).toEqual([]);
    expect(result.build.repairApplied).toBe(true);
  });

  it("retries an invalid repair JSON response within the bounded repair stage", async () => {
    invoke.mockResolvedValueOnce(response(game("<canvas></canvas><script>const broken=;</script>"))).mockResolvedValueOnce(response("{invalid repair")).mockResolvedValueOnce(response(game()));
    const result = await freeGenerate("点击计分游戏");
    expect(invoke).toHaveBeenCalledTimes(3); expect(result.validation?.failures).toEqual([]);
  });

  it("provides the tested optional runtime as a managed local asset", async () => {
    invoke.mockResolvedValueOnce(response(game(`<canvas id="game"></canvas><script src="arcane.runtime.js"></script><script>const game=ArcaneRuntime.createGame({canvas:document.querySelector('canvas'),render:ctx=>ctx.fillRect(0,0,10,10)});document.querySelector('canvas').addEventListener('click',()=>game.start());</script>`)));
    const result = await freeGenerate("点击开始的小游戏");
    expect(result.artifact.files.find(file => file.path === "arcane.runtime.js")?.content).toBe(BROWSER_GAME_RUNTIME_JS);
    expect(result.validation?.checks.find(check => check.name === "project_bundle")?.status).toBe("pass");
  });

  it("reports syntax and dependency defects as failed after bounded unsuccessful repair", async () => {
    invoke.mockResolvedValue(response(game("<canvas></canvas><script>const invalid=;requestAnimationFrame(()=>{});addEventListener('keydown',()=>{});</script>")));
    const result = await freeGenerate("做一个点击游戏");
    expect(result.build.status).toBe("failed");
    expect(result.validation?.checks.find(check => check.name === "javascript_syntax")?.status).toBe("fail");
    expect(invoke.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("propagates abort and never starts an aborted request", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(freeGenerate("做一个点击游戏", undefined, { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses a supplied planner decision without another planning call", async () => {
    invoke.mockResolvedValueOnce(response(game()));
    const result = await freeGenerate("game", undefined, { decision: { intent: "点击", needClarification: false, questions: [] } });
    expect(result.intent).toBe("点击"); expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not complete braces inside code strings to salvage a broken response", () => {
    expect(() => parseJsonObject('{"files":[{"content":"function game(){"')).toThrow("完整JSON");
  });

  it("rejects an oversized input before sending a model call", async () => {
    const base = game(); base.files.push({ path: "large.js", content: " ".repeat(60_000), language: "javascript" });
    await expect(freePatch(base.files, "改变颜色", { existingArtifact: base, tokenBudget: 20_000 })).rejects.toThrow("调用尚未发送");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shares token accounting between the planner and creator", async () => {
    invoke.mockResolvedValueOnce({ ...response({ intent: "点击计分", needClarification: false, questions: [] }), usage: { total_tokens: 12_000 } });
    await expect(freeGenerate("game", undefined, { tokenBudget: 15_000 })).rejects.toThrow("任务剩余3000");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shares the job budget across separate streaming planner and creator calls", async () => {
    const options = createGenerationJobOptions({ tokenBudget: 15_000 });
    invoke.mockResolvedValueOnce({ ...response({ intent: "点击计分", needClarification: false, questions: [] }), usage: { total_tokens: 12_000 } });
    const { decision } = await clarifyRequest("game", undefined, options);
    await expect(freeGenerate("game", undefined, { ...options, decision })).rejects.toThrow("任务剩余3000");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not reset the job budget when malformed output triggers a retry", async () => {
    invoke.mockResolvedValueOnce({ ...response("{invalid json"), usage: { total_tokens: 49_000 } });
    await expect(freeGenerate("点击游戏", undefined, { tokenBudget: 50_000 })).rejects.toThrow("任务剩余1000");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("charges conservative usage when the provider omits it and stops repairs honestly", async () => {
    const usage: number[] = [];
    invoke.mockResolvedValueOnce({ ...response(game("<canvas></canvas><script>const broken=;</script>")), usage: undefined });
    const result = await freeGenerate("点击游戏", undefined, { tokenBudget: 20_000, onUsage: value => usage.push(value) });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(usage[0]).toBeGreaterThan(8000);
    expect(usage.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(20_000);
    expect(result.build.status).toBe("failed");
    expect(result.validation?.warnings.join("\n")).toContain("任务剩余");
  });

  it.each(["0", "Infinity", "-1", "", "garbage"])("keeps the 64000 token cap for an invalid configured budget: %s", async invalid => {
    vi.stubEnv("GENERATION_TOKEN_RESERVE", invalid);
    invoke.mockResolvedValueOnce({ ...response({ intent: "点击计分", needClarification: false, questions: [] }), usage: { total_tokens: 63_000 } });
    await expect(freeGenerate("game")).rejects.toThrow("任务剩余1000");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([0, Infinity, -1, 64_001])("rejects invalid explicit job budgets: %s", async tokenBudget => {
    await expect(freeGenerate("点击游戏", undefined, { tokenBudget })).rejects.toThrow("任务token预算");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("atomic project patches", () => {
  it("supports create/modify/rename/delete with exact base hash and metadata preservation", async () => {
    const base = game(); base.files.push({ path: "old.txt", content: "remove me", language: "text" });
    const result = await applyGamePatch(base, { type: "game_patch", baseHash: await artifactDigest(base), operations: [
      { op: "create", file: "first.txt", content: "new" }, { op: "rename", file: "first.txt", to: "renamed.txt" },
      { op: "modify", file: "renamed.txt", content: "updated" }, { op: "delete", file: "old.txt" },
    ] });
    expect(result.files.find(file => file.path === "renamed.txt")?.content).toBe("updated");
    expect(result.files.some(file => file.path === "old.txt")).toBe(false);
    expect(result.controls).toEqual(base.controls); expect(result.title).toBe(base.title);
    expect(base.files.find(file => file.path === "old.txt")?.content).toBe("remove me");
  });

  it("rejects stale, empty, no-op, unsafe and entry-deleting patches", async () => {
    const base = game(), baseHash = await artifactDigest(base);
    for (const patch of [
      { type: "game_patch", baseHash: "stale", operations: [{ op: "delete", file: "index.html" }] },
      { type: "game_patch", baseHash, operations: [] },
      { files: [] }, { files: base.files },
      { files: [{ path: "../invalid", content: "" }] },
      { type: "game_patch", baseHash, operations: [{ op: "delete", file: "index.html" }] },
    ]) await expect(applyGamePatch(base, patch)).rejects.toThrow();
  });

  it("keeps the real existing snapshot in patch generation", async () => {
    const base = game();
    invoke.mockImplementationOnce(async args => {
      const hash = args.messages[1].content.match(/"baseHash":"([a-f0-9]+)"/)?.[1];
      return response({ type: "game_patch", baseHash: hash, operations: [{ op: "modify", file: "index.html", content: base.files[0].content.replace("++score", "score+=2") }] });
    });
    const result = await freePatch(base.files, "点击每次增加两分", { existingArtifact: base });
    expect(result.artifact.title).toBe(base.title);
    expect(result.artifact.controls).toEqual(base.controls);
    expect(result.artifact.files[0].content).toContain("score+=2");
  });

  it("rejects empty model patches instead of returning an unchanged success", async () => {
    invoke.mockResolvedValue(response({ files: [] }));
    await expect(freePatch(game().files, "改变颜色")).rejects.toThrow("产物校验");
  });
});
