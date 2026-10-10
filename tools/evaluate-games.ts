import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { freeGenerate } from "../server/game/freegen";
import { validateArtifact, artifactDigest } from "../shared/game/artifact";
import { validateInBrowser } from "../server/game/browserQa";

export type EvaluationOptions = {
  directory: string;
  output: string;
  datasetFile?: string;
  generate?: boolean;
  allowModelSpend?: boolean;
  maxTokens?: number;
  limit?: number;
};
type EvaluationRecord = {
  id: string;
  tokensCharged: number;
  artifactHash?: string;
  engineering?: string;
  requirementsPassed?: boolean | null;
  qualified: boolean | null;
  elapsedMs?: number;
  error?: string;
};

/** Existing artifacts never trigger generation; only missing files may do so. */
export async function runEvaluation(options: EvaluationOptions) {
  const { directory, output, generate = false, maxTokens = 0, limit = 30 } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 30
    || (generate && (!options.allowModelSpend || !Number.isSafeInteger(maxTokens) || maxTokens < 1))) {
    throw new Error("实模型评测必须显式 --generate --allow-model-spend --max-tokens <预算>；否则只评测现有产物。limit必须为1–30。");
  }
  const dataset = JSON.parse(await readFile(options.datasetFile ?? "evals/game-prompts.json", "utf8"));
  await mkdir(directory, { recursive: true }); await mkdir(output, { recursive: true });
  let tokensCharged = 0;
  const records: EvaluationRecord[] = [];
  const summary = () => ({
    modelCallsEnabled: generate,
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
    try {
      let saved: string | undefined;
      try { saved = await readFile(filename, "utf8"); }
      catch (error) {
        if (!generate || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (saved !== undefined) artifact = JSON.parse(saved);
      else {
        const remaining = maxTokens - tokensCharged;
        if (remaining <= 0) throw new Error("已达到实模型评测token预算；调用尚未发送。");
        const configuredReserve = Number(process.env.GENERATION_TOKEN_RESERVE);
        const reserve = Number.isSafeInteger(configuredReserve) && configuredReserve > 0 ? configuredReserve : 64_000;
        const result = await freeGenerate(sample.prompt, undefined, {
          tokenBudget: Math.min(remaining, reserve),
          // Missing/failed usage is already charged conservatively. A callback
          // must not discard an artifact by throwing after a paid response.
          onUsage: usage => { tokensCharged += usage; },
        });
        artifact = result.artifact;
        await writeFile(filename, JSON.stringify(artifact, null, 2));
      }
      const validation = validateArtifact(artifact);
      if (!validation.artifact) throw new Error(validation.errors.join("; "));
      const report = await validateInBrowser(validation.artifact);
      await writeFile(path.join(output, `${sample.id}.report.json`), JSON.stringify(report, null, 2));
      let acceptance: Record<string, boolean> | null = null;
      try { acceptance = JSON.parse(await readFile(path.join(directory, `${sample.id}.acceptance.json`), "utf8")); } catch { /* No fabricated gameplay result. */ }
      const requirementsPassed = acceptance ? sample.requiredAcceptance.every((requirement: string) => acceptance?.[requirement] === true) : null;
      records.push({ id: sample.id, tokensCharged: tokensCharged - chargedBefore, artifactHash: await artifactDigest(validation.artifact), engineering: report.status, requirementsPassed, qualified: requirementsPassed === null ? null : report.status === "passed" && requirementsPassed, elapsedMs: Math.round(performance.now() - start) });
    } catch (error) { records.push({ id: sample.id, tokensCharged: tokensCharged - chargedBefore, error: error instanceof Error ? error.message : "未能评测", qualified: null }); }
    await writeFile(path.join(output, "summary.json"), JSON.stringify(summary(), null, 2));
  }
  return summary();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback?: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
  const output = path.resolve(option("--out", "evals/results")!);
  const result = await runEvaluation({
    directory: path.resolve(option("--artifacts", "evals/artifacts")!), output,
    generate: args.includes("--generate"), allowModelSpend: args.includes("--allow-model-spend"),
    maxTokens: Number(option("--max-tokens", "0")), limit: Number(option("--limit", "30")),
  });
  console.log(JSON.stringify({ evaluated: result.samples.length, tokensCharged: result.tokensCharged, tokensReported: result.tokensReported, output, qualifiedGames: result.qualifiedGames }));
}
