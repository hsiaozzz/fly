import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { freeGenerate, GenerationBudgetError } from "../server/game/freegen";
import { validateArtifact, artifactDigest } from "../shared/game/artifact";
import { validateInBrowser } from "../server/game/browserQa";
import { assessManualAcceptance, createAcceptanceTemplate, evaluationSampleHash, parseEvaluationDataset, type EvaluationSample, type ManualAcceptanceAssessment, type ManualAcceptanceStatus } from "../shared/game/evaluation";

export type EvaluationOptions = {
  directory: string;
  output: string;
  datasetFile?: string;
  generate?: boolean;
  allowModelSpend?: boolean;
  maxTokens?: number;
  limit?: number;
  prepareAcceptance?: boolean;
};
export type EvaluationRecord = {
  id: string;
  tokensCharged: number;
  artifactHash?: string;
  sampleContractHash?: string;
  engineering?: string;
  acceptanceMethod?: "manual-claim";
  acceptanceStatus?: ManualAcceptanceStatus;
  acceptanceDiagnostics?: string[];
  acceptanceTemplate?: "created" | "preserved";
  requirementsPassed: boolean | null;
  qualified: boolean | null;
  elapsedMs?: number;
  errorCategory?: EvaluationFailureCategory;
  errorHttpStatus?: number;
  errorKind?: "timeout" | "aborted";
  error?: string;
};

const failureMessages = {
  "artifact-missing": "现有游戏产物缺失，未启用模型生成。",
  "artifact-read-failed": "游戏产物无法读取。",
  "artifact-invalid": "现有游戏产物 JSON 或结构不合法，未自动重建。",
  "artifact-write-failed": "生成已完成，但游戏产物无法保存；已有文件不会覆盖。",
  "model-budget": "模型调用未发送：保守 token 预算不足。",
  "model-failed": "模型生成未完成；已发送调用的用量继续保守累计。",
  "browser-failed": "浏览器验证未完成，无法确认工程质量。",
  "report-binding-invalid": "浏览器报告未绑定本次产物及测试环境，不能计入工程结果。",
  "report-write-failed": "浏览器报告无法保存。",
  "acceptance-template-write-failed": "人工验收模板无法保存。",
} as const;
type EvaluationFailureCategory = keyof typeof failureMessages;
class EvaluationFailure extends Error {
  constructor(readonly category: EvaluationFailureCategory) { super(failureMessages[category]); }
}

async function readAcceptance(directory: string, sample: EvaluationSample, hash: string, contractHash: string): Promise<ManualAcceptanceAssessment> {
  let saved: string;
  try { saved = await readFile(path.join(directory, `${sample.id}.acceptance.json`), "utf8"); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing", requirementsPassed: null, diagnostics: ["尚无人工试玩记录。"] }
      : { status: "invalid", requirementsPassed: null, diagnostics: ["人工验收文件无法读取。"] };
  }
  let evidence: unknown;
  try { evidence = JSON.parse(saved); }
  catch { return { status: "invalid", requirementsPassed: null, diagnostics: ["人工验收文件 JSON 不合法。"] }; }
  return assessManualAcceptance(evidence, sample, hash, contractHash);
}

/** Existing artifacts never trigger generation; only missing files may do so. */
export async function runEvaluation(options: EvaluationOptions) {
  const { directory, output, generate = false, maxTokens = 0, limit = 30, prepareAcceptance = false } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 30
    || (generate && (!options.allowModelSpend || !Number.isSafeInteger(maxTokens) || maxTokens < 1))) {
    throw new Error("实模型评测必须显式 --generate --allow-model-spend --max-tokens <预算>；否则只评测现有产物。limit必须为1–30。");
  }
  if (prepareAcceptance && (generate || options.allowModelSpend || maxTokens !== 0)) throw new Error("--prepare-acceptance 仅准备未填写的人工验收模板，不能与模型付费开关或 token 预算同时使用。");
  let rawDataset: unknown;
  try { rawDataset = JSON.parse(await readFile(options.datasetFile ?? "evals/game-prompts.json", "utf8")); }
  catch { throw new Error("评测数据集无法读取或 JSON 不合法。"); }
  // Validate every case, including those beyond --limit, before any side effect.
  const dataset = parseEvaluationDataset(rawDataset);
  try { await mkdir(directory, { recursive: true }); await mkdir(output, { recursive: true }); }
  catch { throw new Error("评测产物或报告目录无法创建。"); }
  let tokensCharged = 0;
  const records: EvaluationRecord[] = [];
  const summary = () => ({
    schemaVersion: 1 as const,
    modelCallsEnabled: generate,
    prepareAcceptance,
    qualificationBasis: "engineering-and-manual-claim" as const,
    budgetScope: "invocation" as const,
    tokensCharged,
    // Compatibility only: this includes conservative charges, not just
    // provider-reported usage. New consumers should read tokensCharged.
    tokensReported: tokensCharged,
    samples: records,
    qualifiedGames: records.filter(record => record.qualified === true).length,
    unverifiedRequirements: records.filter(record => record.requirementsPassed == null).length,
  });
  for (const sample of dataset.cases.slice(0, limit)) {
    const start = performance.now(), chargedBefore = tokensCharged;
    const filename = path.join(directory, `${sample.id}.json`);
    let artifact;
    let stage: EvaluationFailureCategory = "artifact-read-failed";
    try {
      let saved: string | undefined;
      try { saved = await readFile(filename, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new EvaluationFailure("artifact-read-failed");
        if (!generate) throw new EvaluationFailure("artifact-missing");
      }
      if (saved !== undefined) { stage = "artifact-invalid"; artifact = JSON.parse(saved); }
      else {
        stage = "model-failed";
        const remaining = maxTokens - tokensCharged;
        if (remaining <= 0) throw new EvaluationFailure("model-budget");
        const configuredReserve = Number(process.env.GENERATION_TOKEN_RESERVE);
        const reserve = Number.isSafeInteger(configuredReserve) && configuredReserve > 0 ? configuredReserve : 64_000;
        const result = await freeGenerate(sample.prompt, undefined, {
          tokenBudget: Math.min(remaining, reserve),
          // Missing/failed usage is already charged conservatively. A callback
          // must not discard an artifact by throwing after a paid response.
          onUsage: usage => { tokensCharged += usage; },
        });
        artifact = result.artifact;
        stage = "artifact-write-failed";
        await writeFile(filename, JSON.stringify(artifact, null, 2), { flag: "wx" });
      }
      stage = "artifact-invalid";
      const validation = validateArtifact(artifact);
      if (!validation.artifact) throw new EvaluationFailure("artifact-invalid");
      const hash = await artifactDigest(validation.artifact), contractHash = await evaluationSampleHash(sample);
      let engineering: string = "not-run", acceptanceTemplate: "created" | "preserved" | undefined;
      if (prepareAcceptance) {
        stage = "acceptance-template-write-failed";
        try {
          await writeFile(path.join(directory, `${sample.id}.acceptance.json`), JSON.stringify(createAcceptanceTemplate(sample, hash, contractHash), null, 2), { flag: "wx" });
          acceptanceTemplate = "created";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          acceptanceTemplate = "preserved";
        }
      } else {
        stage = "browser-failed";
        const report = await validateInBrowser(validation.artifact, { seed: sample.seeds[0], viewport: sample.viewports[0] });
        if (report.schemaVersion !== 1 || report.artifactHash !== hash || !["passed", "failed", "unverified"].includes(report.status)
          || report.environment?.seed !== sample.seeds[0] || report.environment?.viewport?.width !== sample.viewports[0].width || report.environment?.viewport?.height !== sample.viewports[0].height) throw new EvaluationFailure("report-binding-invalid");
        stage = "report-write-failed";
        await writeFile(path.join(output, `${sample.id}.report.json`), JSON.stringify(report, null, 2));
        engineering = report.status;
      }
      const acceptance = await readAcceptance(directory, sample, hash, contractHash);
      const { requirementsPassed } = acceptance;
      records.push({
        id: sample.id, tokensCharged: tokensCharged - chargedBefore,
        artifactHash: hash, sampleContractHash: contractHash, engineering,
        acceptanceMethod: "manual-claim", acceptanceStatus: acceptance.status,
        acceptanceDiagnostics: acceptance.diagnostics, acceptanceTemplate,
        requirementsPassed,
        qualified: requirementsPassed === null || engineering === "not-run" || engineering === "unverified" ? null : engineering === "passed" && requirementsPassed,
        elapsedMs: Math.round(performance.now() - start),
      });
    } catch (error) {
      const category = error instanceof GenerationBudgetError ? "model-budget" : error instanceof EvaluationFailure ? error.category : stage;
      // Only trusted fixed-format status and finite error names may be retained.
      const status = category === "model-failed" && error instanceof Error ? /^模型服务请求失败（HTTP ([1-5]\d{2})）。$/.exec(error.message) : null;
      const errorKind = error instanceof Error && error.name === "TimeoutError" ? "timeout" : error instanceof Error && error.name === "AbortError" ? "aborted" : undefined;
      records.push({ id: sample.id, tokensCharged: tokensCharged - chargedBefore, errorCategory: category, error: failureMessages[category], errorHttpStatus: status ? Number(status[1]) : undefined, errorKind, requirementsPassed: null, qualified: null });
    }
    try { await writeFile(path.join(output, "summary.json"), JSON.stringify(summary(), null, 2)); }
    catch { throw new Error("评测汇总无法保存。"); }
  }
  return summary();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback?: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
  const output = path.resolve(option("--out", "evals/results")!);
  const result = await runEvaluation({
    directory: path.resolve(option("--artifacts", "evals/artifacts")!), output,
    datasetFile: option("--dataset"), prepareAcceptance: args.includes("--prepare-acceptance"),
    generate: args.includes("--generate"), allowModelSpend: args.includes("--allow-model-spend"),
    maxTokens: Number(option("--max-tokens", "0")), limit: Number(option("--limit", "30")),
  });
  console.log(JSON.stringify({ evaluated: result.samples.length, tokensCharged: result.tokensCharged, tokensReported: result.tokensReported, output, qualifiedGames: result.qualifiedGames }));
}
