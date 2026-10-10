import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const { invoke, browser } = vi.hoisted(() => ({ invoke: vi.fn(), browser: vi.fn() }));
vi.mock("dotenv/config", () => ({}));
vi.mock("../_core/llm", () => ({ invokeLLM: invoke }));
vi.mock("./browserQa", () => ({ validateInBrowser: browser }));
import { runEvaluation, type EvaluationOptions } from "../../tools/evaluate-games";
import { artifactDigest } from "../../shared/game/artifact";
import { createAcceptanceTemplate, evaluationSampleHash, type EvaluationDataset, type EvaluationSample, type ManualAcceptanceEvidence } from "../../shared/game/evaluation";
import type { GameArtifact } from "../../shared/game/types";
import type { BrowserQaOptions } from "./browserQa";

const artifact: GameArtifact = { title: "点击计分", description: "点击按钮得分", controls: ["点击"], files: [{ path: "index.html", language: "html", content: "<!doctype html><html><body><button id='score'>0</button><script>let score=0;document.querySelector('#score').addEventListener('click',()=>{document.querySelector('#score').textContent=++score});</script></body></html>" }] };
let temporary: string, options: EvaluationOptions, dataset: EvaluationDataset;
const makeSample = (id: string): EvaluationSample => ({ id, category: "点击计分", prompt: "点击计分游戏", seeds: [42, 43], viewports: [{ width: 960, height: 640 }, { width: 390, height: 844 }], requiredAcceptance: ["点击增加得分"], acceptanceMode: "manual-until-scenario-available" });
const offline = (): EvaluationOptions => ({ ...options, generate: false, allowModelSpend: false, maxTokens: 0, limit: 1 });
const saveDataset = async (value: unknown = dataset) => writeFile(options.datasetFile!, JSON.stringify(value));
const saveArtifact = async (value: unknown = artifact) => writeFile(path.join(options.directory, "one.json"), JSON.stringify(value));
const saveEvidence = async (value: unknown) => writeFile(path.join(options.directory, "one.acceptance.json"), JSON.stringify(value));
const makeEvidence = async (): Promise<ManualAcceptanceEvidence> => ({
  ...createAcceptanceTemplate(dataset.cases[0], await artifactDigest(artifact), await evaluationSampleHash(dataset.cases[0])),
  reviewer: "test-reviewer", reviewedAt: "2026-10-10T12:00:00.000Z",
  checks: dataset.cases[0].requiredAcceptance.map(requirement => ({ requirement, passed: true, observation: "人工点击按钮一次，得分从 0 增加到 1。" })),
});
const makeReport = async (input: GameArtifact, environment: BrowserQaOptions = {}) => ({
  schemaVersion: 1, artifactHash: await artifactDigest(input), status: "passed",
  environment: { runner: "playwright", seed: environment.seed ?? 42, viewport: environment.viewport ?? { width: 960, height: 640 } },
  checks: [], errors: [], durationMs: 1, testedAt: "2026-10-10T12:00:00.000Z",
});
beforeEach(async () => {
  invoke.mockReset(); browser.mockReset(); vi.unstubAllEnvs();
  vi.stubEnv("GENERATION_TOKEN_RESERVE", "64000");
  browser.mockImplementation(makeReport);
  temporary = await mkdtemp(path.join(tmpdir(), "arcane-eval-budget-"));
  options = { directory: path.join(temporary, "artifacts"), output: path.join(temporary, "results"), datasetFile: path.join(temporary, "cases.json"), generate: true, allowModelSpend: true, maxTokens: 20_000, limit: 2 };
  dataset = { schemaVersion: 1, cases: ["one", "two"].map(makeSample) };
  await mkdir(options.directory);
  await saveDataset();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(temporary, { recursive: true, force: true }); });

describe("evaluation budget and existing-artifact handling", () => {
  it("blocks an 8000-output generation before sending when only 5000 global tokens remain", async () => {
    const result = await runEvaluation({ ...options, maxTokens: 5000 });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.tokensCharged).toBe(0);
    expect(result.samples.every(sample => sample.errorCategory === "model-budget")).toBe(true);
  });

  it("caps each job at the server reserve even with a larger evaluation budget", async () => {
    vi.stubEnv("GENERATION_TOKEN_RESERVE", "10000");
    const result = await runEvaluation({ ...options, maxTokens: 100_000 });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.samples[0].errorCategory).toBe("model-budget");
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
    expect(result.samples[1].errorCategory).toBe("model-budget");
    expect(JSON.parse(await readFile(path.join(options.directory, "one.json"), "utf8")).title).toBe(artifact.title);
    expect(browser).toHaveBeenCalledTimes(1);
  });

  it("retains conservative charges after a failed model request", async () => {
    invoke.mockRejectedValue(new Error("transport lost after POST"));
    const result = await runEvaluation(options);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.tokensCharged).toBeGreaterThan(8000);
    expect(result.tokensCharged).toBeLessThanOrEqual(20_000);
    expect(result.samples[0].errorCategory).toBe("model-failed");
    expect(result.samples[0].error).not.toContain("transport lost");
    expect(result.samples[1].errorCategory).toBe("model-budget");
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

describe("manual gameplay claims bound to the exact artifact and contract", () => {
  beforeEach(async () => { await saveArtifact(); });

  it("keeps missing evidence unknown despite a passed engineering report", async () => {
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ engineering: "passed", acceptanceStatus: "missing", requirementsPassed: null, qualified: null });
    expect(result.qualifiedGames).toBe(0);
    expect(result.unverifiedRequirements).toBe(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("counts only matching complete manual claims and identifies their qualification basis", async () => {
    await saveEvidence(await makeEvidence());
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ acceptanceMethod: "manual-claim", acceptanceStatus: "complete", requirementsPassed: true, qualified: true });
    expect(result.samples[0].artifactHash).toBe(await artifactDigest(artifact));
    expect(result.samples[0].sampleContractHash).toBe(await evaluationSampleHash(dataset.cases[0]));
    expect(result.qualificationBasis).toBe("engineering-and-manual-claim");
    expect(result.budgetScope).toBe("invocation");
    expect(result.qualifiedGames).toBe(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("records a valid reviewed false as failure instead of unknown", async () => {
    const evidence = await makeEvidence(); evidence.checks[0].passed = false;
    await saveEvidence(evidence);
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ acceptanceStatus: "complete", requirementsPassed: false, qualified: false });
    expect(result.unverifiedRequirements).toBe(0);
  });

  it.each(["reviewer", "reviewedAt", "passed", "observation"] as const)("keeps pending %s unknown", async field => {
    const evidence = await makeEvidence();
    if (field === "reviewer" || field === "reviewedAt") evidence[field] = null;
    else evidence.checks[0][field] = null;
    await saveEvidence(evidence);
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ acceptanceStatus: "incomplete", requirementsPassed: null, qualified: null });
    expect(result.qualifiedGames).toBe(0);
  });

  it.each([{}, { 点击增加得分: true }, { 点击增加得分: false }])("does not accept a legacy boolean map: %j", async evidence => {
    await saveEvidence(evidence);
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ acceptanceStatus: "legacy", requirementsPassed: null, qualified: null });
    expect(result.samples[0].acceptanceDiagnostics?.length).toBeGreaterThan(0);
  });

  it("explicitly marks malformed JSON invalid", async () => {
    await writeFile(path.join(options.directory, "one.acceptance.json"), "{invalid-evidence");
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ acceptanceStatus: "invalid", requirementsPassed: null, qualified: null });
  });

  it.each(["true", "false", 1, 0, {}])("rejects nonboolean criterion values: %j", async value => {
    const evidence = await makeEvidence();
    await saveEvidence({ ...evidence, checks: [{ ...evidence.checks[0], passed: value }] });
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ acceptanceStatus: "invalid", requirementsPassed: null, qualified: null });
  });

  it.each(["version", "method", "extra-field", "missing-field", "duplicate", "missing-criterion", "extra-criterion", "date", "blank-observation"])("rejects invalid evidence shape: %s", async defect => {
    const evidence = await makeEvidence();
    let value: unknown = evidence;
    if (defect === "version") value = { ...evidence, schemaVersion: 2 };
    if (defect === "method") value = { ...evidence, method: "automatic" };
    if (defect === "extra-field") value = { ...evidence, automaticallyProven: true };
    if (defect === "missing-field") { const { reviewer: _, ...rest } = evidence; value = rest; }
    if (defect === "duplicate") evidence.checks.push({ ...evidence.checks[0] });
    if (defect === "missing-criterion") evidence.checks = [];
    if (defect === "extra-criterion") evidence.checks.push({ requirement: "未要求的玩法", passed: true, observation: "观察" });
    if (defect === "date") evidence.reviewedAt = "yesterday";
    if (defect === "blank-observation") evidence.checks[0].observation = "   ";
    await saveEvidence(value);
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ acceptanceStatus: "invalid", requirementsPassed: null, qualified: null });
  });

  it.each(["source", "metadata", "non-entry-file"])("invalidates evidence when artifact %s changes", async change => {
    await saveEvidence(await makeEvidence());
    const changed = structuredClone(artifact);
    if (change === "source") changed.files[0].content += "\n<!-- modified -->";
    if (change === "metadata") changed.description += "，已修改";
    if (change === "non-entry-file") changed.files.push({ path: "settings.json", language: "json", content: "{}" });
    await saveArtifact(changed);
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ acceptanceStatus: "stale", requirementsPassed: null, qualified: null });
  });

  it.each(["prompt", "requiredAcceptance", "seeds", "viewports"] as const)("invalidates evidence when contract %s changes under the same id", async field => {
    await saveEvidence(await makeEvidence());
    const sample = dataset.cases[0];
    if (field === "prompt") sample.prompt += "，支持重开。";
    if (field === "requiredAcceptance") sample.requiredAcceptance.push("重开清零");
    if (field === "seeds") sample.seeds = [90, 91];
    if (field === "viewports") sample.viewports[0] = { width: 1024, height: 768 };
    await saveDataset();
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ acceptanceStatus: "stale", requirementsPassed: null, qualified: null });
  });

  it("rejects evidence copied from another sample", async () => {
    const evidence = await makeEvidence(); evidence.sampleId = "two";
    await saveEvidence(evidence);
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ acceptanceStatus: "stale", requirementsPassed: null, qualified: null });
  });

  it("cannot reuse old evidence when a missing artifact is regenerated", async () => {
    await saveEvidence(await makeEvidence());
    await rm(path.join(options.directory, "one.json"));
    invoke.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ ...artifact, title: "重新生成的点击游戏" }) }, finish_reason: "stop" }], usage: { total_tokens: 1000 } });
    const result = await runEvaluation({ ...options, limit: 1 });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.samples[0]).toMatchObject({ acceptanceStatus: "stale", requirementsPassed: null, qualified: null });
  });

  it("passes the contract's supported seeds and viewports into the browser runner", async () => {
    dataset.cases[0].seeds = [90, 91]; dataset.cases[0].viewports[0] = { width: 1024, height: 768 };
    await saveDataset();
    await runEvaluation(offline());
    expect(browser).toHaveBeenCalledWith(artifact, { seed: 90, viewport: { width: 1024, height: 768 } });
  });

  it.each(["artifact", "seed", "viewport"])("cannot qualify when the browser report's %s binding differs", async binding => {
    await saveEvidence(await makeEvidence());
    browser.mockImplementation(async (input, environment) => {
      const report = await makeReport(input, environment);
      if (binding === "artifact") report.artifactHash = "0".repeat(64);
      if (binding === "seed") report.environment.seed++;
      if (binding === "viewport") report.environment.viewport = { width: 800, height: 600 };
      return report;
    });
    const result = await runEvaluation(offline());
    expect(result.samples[0]).toMatchObject({ errorCategory: "report-binding-invalid", requirementsPassed: null, qualified: null });
  });

  it.each(["failed", "unverified"])("does not count a complete claim when engineering is %s", async status => {
    await saveEvidence(await makeEvidence());
    browser.mockImplementation(async (input, environment) => ({ ...await makeReport(input, environment), status }));
    const result = await runEvaluation(offline());
    expect(result.samples[0].requirementsPassed).toBe(true);
    expect(result.samples[0].qualified).toBe(status === "failed" ? false : null);
    expect(result.qualifiedGames).toBe(0);
  });
});

type RawDataset = { schemaVersion: number; cases: Array<Record<string, unknown>> };
const invalidDatasets: Array<[string, (value: RawDataset) => void]> = [
  ["path traversal", value => { value.cases[1].id = "../escape"; }],
  ["absolute path", value => { value.cases[0].id = "/tmp/escape"; }],
  ["Windows path traversal", value => { value.cases[0].id = "..\\escape"; }],
  ["reserved filename", value => { value.cases[0].id = "CON"; }],
  ["duplicate id", value => { value.cases[1].id = "one"; }],
  ["case-insensitive duplicate id", value => { value.cases[1].id = "ONE"; }],
  ["empty criteria", value => { value.cases[0].requiredAcceptance = []; }],
  ["blank criterion", value => { value.cases[0].requiredAcceptance = ["   "]; }],
  ["duplicate criterion", value => { value.cases[0].requiredAcceptance = ["点击增加得分", " 点击增加得分 "]; }],
  ["blank prompt", value => { value.cases[0].prompt = "   "; }],
  ["empty seeds", value => { value.cases[0].seeds = []; }],
  ["duplicate seeds", value => { value.cases[0].seeds = [42, 42]; }],
  ["unsupported seed pair", value => { value.cases[0].seeds = [42, 44]; }],
  ["extra seed", value => { value.cases[0].seeds = [42, 43, 44]; }],
  ["negative seed", value => { value.cases[0].seeds = [-1, 0]; }],
  ["seed overflow", value => { value.cases[0].seeds = [4294967295, 4294967296]; }],
  ["string seed", value => { value.cases[0].seeds = ["42", 43]; }],
  ["empty viewports", value => { value.cases[0].viewports = []; }],
  ["duplicate viewports", value => { value.cases[0].viewports = [{ width: 390, height: 844 }, { width: 390, height: 844 }]; }],
  ["unsupported second viewport", value => { value.cases[0].viewports = [{ width: 960, height: 640 }, { width: 400, height: 800 }]; }],
  ["invalid viewport dimensions", value => { value.cases[0].viewports = [{ width: 0, height: 640 }, { width: 390, height: 844 }]; }],
  ["unsupported acceptance mode", value => { value.cases[0].acceptanceMode = "automatic"; }],
  ["empty cases", value => { value.cases = []; }],
  ["unsupported dataset version", value => { value.schemaVersion = 2; }],
];

describe("dataset validation before filesystem/model/browser side effects", () => {
  it.each(invalidDatasets)("rejects %s, including invalid cases beyond the requested limit", async (_, mutate) => {
    const value = structuredClone(dataset) as unknown as RawDataset; mutate(value);
    await saveDataset(value);
    const untouched = { ...options, directory: path.join(temporary, "untouched-artifacts"), output: path.join(temporary, "untouched-results"), limit: 1 };
    await expect(runEvaluation(untouched)).rejects.toThrow("评测数据集不合法");
    expect(invoke).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
    await expect(stat(untouched.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(untouched.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the checked-in 30-case dataset without running any model or browser", async () => {
    const { parseEvaluationDataset } = await import("../../shared/game/evaluation");
    const checkedIn = parseEvaluationDataset(JSON.parse(await readFile(path.resolve("evals/game-prompts.json"), "utf8")));
    expect(checkedIn.cases).toHaveLength(30);
    expect(invoke).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
  });
});

describe("nonpaid acceptance template preparation", () => {
  it("writes all-null bound templates without calling a model or browser", async () => {
    await saveArtifact();
    const result = await runEvaluation({ ...offline(), prepareAcceptance: true });
    const evidence = JSON.parse(await readFile(path.join(options.directory, "one.acceptance.json"), "utf8"));
    expect(evidence).toMatchObject({ schemaVersion: 1, sampleId: "one", reviewer: null, reviewedAt: null, artifactHash: await artifactDigest(artifact), sampleContractHash: await evaluationSampleHash(dataset.cases[0]) });
    expect(evidence.checks).toEqual([{ requirement: "点击增加得分", passed: null, observation: null }]);
    expect(result.samples[0]).toMatchObject({ engineering: "not-run", acceptanceTemplate: "created", acceptanceStatus: "incomplete", requirementsPassed: null, qualified: null });
    expect(result.tokensCharged).toBe(0); expect(result.qualifiedGames).toBe(0);
    expect(invoke).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
  });

  it.each(["complete", "corrupt"])("preserves existing %s evidence byte-for-byte", async existing => {
    await saveArtifact();
    const saved = existing === "complete" ? JSON.stringify(await makeEvidence()) : "{invalid-evidence";
    await writeFile(path.join(options.directory, "one.acceptance.json"), saved);
    const result = await runEvaluation({ ...offline(), prepareAcceptance: true });
    expect(await readFile(path.join(options.directory, "one.acceptance.json"), "utf8")).toBe(saved);
    expect(result.samples[0].acceptanceTemplate).toBe("preserved");
    expect(result.samples[0].qualified).toBe(null); expect(result.qualifiedGames).toBe(0);
    expect(invoke).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
  });

  it.each([{ generate: true }, { allowModelSpend: true }, { maxTokens: 1 }])("rejects paid switches during preparation: %j", async override => {
    await expect(runEvaluation({ ...offline(), prepareAcceptance: true, ...override })).rejects.toThrow(/prepare-acceptance|实模型评测/);
    expect(invoke).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
    await expect(stat(options.output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not generate missing artifacts while preparing acceptance", async () => {
    const result = await runEvaluation({ ...offline(), prepareAcceptance: true });
    expect(result.samples[0]).toMatchObject({ errorCategory: "artifact-missing", requirementsPassed: null, qualified: null });
    expect(invoke).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
    await expect(readFile(path.join(options.directory, "one.acceptance.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("shareable evaluation errors", () => {
  it.each([401, 404, 429, 500, 503])("retains trusted fixed-format model HTTP %s without raw response data", async status => {
    invoke.mockRejectedValue(new Error(`模型服务请求失败（HTTP ${status}）。`));
    const result = await runEvaluation({ ...options, limit: 1 });
    expect(result.samples[0]).toMatchObject({ errorCategory: "model-failed", errorHttpStatus: status });
    expect(result.tokensCharged).toBeGreaterThan(8000);
  });

  it("does not extract HTTP status from untrusted raw response text", async () => {
    invoke.mockRejectedValue(new Error("upstream HTTP 429 api_key=dummy-secret-only-for-test"));
    const result = await runEvaluation({ ...options, limit: 1 });
    expect(result.samples[0].errorHttpStatus).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("dummy-secret");
  });

  it.each(["TimeoutError", "AbortError"])("retains only the finite error kind for %s", async name => {
    const error = new Error("host/private/path or raw provider data"); error.name = name;
    invoke.mockRejectedValue(error);
    const result = await runEvaluation({ ...options, limit: 1 });
    expect(result.samples[0].errorKind).toBe(name === "TimeoutError" ? "timeout" : "aborted");
    expect(JSON.stringify(result)).not.toContain("host/private/path");
  });

  it("retains failed-call charges without exposing provider bodies, credentials or paths", async () => {
    invoke.mockRejectedValue(new Error("provider raw body: api_key=dummy-secret-only-for-test, /host/private/path"));
    const result = await runEvaluation({ ...options, limit: 1 });
    expect(result.samples[0].errorCategory).toBe("model-failed");
    expect(result.tokensCharged).toBeGreaterThan(8000);
    const saved = await readFile(path.join(options.output, "summary.json"), "utf8");
    expect(saved).not.toMatch(/provider raw body|dummy-secret|host\/private/);
  });

  it("does not expose raw browser exceptions", async () => {
    await saveArtifact(); browser.mockRejectedValue(new Error("private browser executable: /host/private/path"));
    const result = await runEvaluation(offline());
    expect(result.samples[0].errorCategory).toBe("browser-failed");
    expect(JSON.stringify(result)).not.toContain("/host/private/path");
  });

  it("does not expose untrusted artifact paths from validation errors", async () => {
    const value = structuredClone(artifact); value.files[0].path = "../host/private/path";
    await saveArtifact(value);
    const result = await runEvaluation(offline());
    expect(result.samples[0].errorCategory).toBe("artifact-invalid");
    expect(JSON.stringify(result)).not.toContain("host/private/path");
    expect(invoke).not.toHaveBeenCalled(); expect(browser).not.toHaveBeenCalled();
  });
});
