import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const { invoke, browser } = vi.hoisted(() => ({ invoke: vi.fn(), browser: vi.fn() }));
vi.mock("../_core/llm", () => ({ invokeLLM: invoke }));
vi.mock("./browserQa", () => ({ validateInBrowser: browser }));
import { runEvaluation, type EvaluationOptions } from "../../tools/evaluate-games";

const artifact = { title: "点击计分", description: "点击按钮得分", controls: ["点击"], files: [{ path: "index.html", language: "html", content: "<!doctype html><html><body><button id='score'>0</button><script>let score=0;document.querySelector('#score').addEventListener('click',()=>{document.querySelector('#score').textContent=++score});</script></body></html>" }] };
let temporary: string, options: EvaluationOptions;
beforeEach(async () => {
  invoke.mockReset(); browser.mockReset(); vi.unstubAllEnvs();
  browser.mockResolvedValue({ status: "passed" });
  temporary = await mkdtemp(path.join(tmpdir(), "arcane-eval-budget-"));
  options = { directory: path.join(temporary, "artifacts"), output: path.join(temporary, "results"), datasetFile: path.join(temporary, "cases.json"), generate: true, allowModelSpend: true, maxTokens: 20_000, limit: 2 };
  await mkdir(options.directory);
  await writeFile(options.datasetFile!, JSON.stringify({ cases: ["one", "two"].map(id => ({ id, prompt: "点击计分游戏", requiredAcceptance: ["点击增加得分"] })) }));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(temporary, { recursive: true, force: true }); });

describe("evaluation budget and existing-artifact handling", () => {
  it("blocks an 8000-output generation before sending when only 5000 global tokens remain", async () => {
    const result = await runEvaluation({ ...options, maxTokens: 5000 });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.tokensCharged).toBe(0);
    expect(result.samples.every(sample => sample.error?.includes("任务剩余5000"))).toBe(true);
  });

  it("caps each job at the server reserve even with a larger evaluation budget", async () => {
    vi.stubEnv("GENERATION_TOKEN_RESERVE", "10000");
    const result = await runEvaluation({ ...options, maxTokens: 100_000 });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.samples[0].error).toContain("任务剩余10000");
  });

  it("charges missing usage conservatively and preserves a generated artifact before denying the next sample", async () => {
    invoke.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(artifact) }, finish_reason: "stop" }] });
    const result = await runEvaluation(options);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.tokensCharged).toBeGreaterThan(8000);
    expect(result.tokensCharged).toBeLessThanOrEqual(20_000);
    expect(result.tokensReported).toBe(result.tokensCharged);
    expect(result.samples[0].error).toBeUndefined();
    expect(result.samples[0].tokensCharged).toBe(result.tokensCharged);
    expect(result.samples[1].tokensCharged).toBe(0);
    expect(result.samples[1].error).toContain("任务剩余");
    expect(JSON.parse(await readFile(path.join(options.directory, "one.json"), "utf8")).title).toBe(artifact.title);
    expect(browser).toHaveBeenCalledTimes(1);
  });

  it("retains conservative charges after a failed model request", async () => {
    invoke.mockRejectedValue(new Error("transport lost after POST"));
    const result = await runEvaluation(options);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.tokensCharged).toBeGreaterThan(8000);
    expect(result.tokensCharged).toBeLessThanOrEqual(20_000);
    expect(result.samples[0].error).toBe("transport lost after POST");
    expect(result.samples[1].error).toContain("任务剩余");
  });

  it("evaluates existing artifacts by default without calling a model", async () => {
    await writeFile(path.join(options.directory, "one.json"), JSON.stringify(artifact));
    const result = await runEvaluation({ ...options, generate: false, allowModelSpend: false, maxTokens: 0 });
    expect(invoke).not.toHaveBeenCalled();
    expect(browser).toHaveBeenCalledTimes(1);
    expect(result.tokensCharged).toBe(0);
    expect(result.samples[0].qualified).toBe(null);
  });

  it.each([false, true])("does not rebuild an existing corrupt artifact even with generate=%s", async generate => {
    await writeFile(path.join(options.directory, "one.json"), "{invalid artifact");
    const result = await runEvaluation({ ...options, generate, limit: 1 });
    expect(invoke).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
    expect(result.samples[0].error).toBeTruthy();
    expect(await readFile(path.join(options.directory, "one.json"), "utf8")).toBe("{invalid artifact");
  });
});
