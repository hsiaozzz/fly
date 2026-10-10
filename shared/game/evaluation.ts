import { z } from "zod";

const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0, "内容不能为空白。");
const hash = z.string().regex(/^[a-f0-9]{64}$/, "必须是 SHA-256 摘要。");
const sampleId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/, "样本 id 只能包含字母、数字、下划线或连字符。")
  .refine(value => !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value), "样本 id 不能使用系统保留文件名。");
const viewport = z.object({ width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) }).strict();

export const evaluationSampleSchema = z.object({
  id: sampleId,
  category: text(120),
  prompt: text(8000),
  // The runner expands the first seed to [seed, seed + 1], and always uses
  // 390 x 844 for its second viewport. Reject unsupported contracts explicitly.
  seeds: z.tuple([z.number().int().min(0).max(0xffff_fffe), z.number().int().min(1).max(0xffff_ffff)]),
  viewports: z.tuple([viewport, z.object({ width: z.literal(390), height: z.literal(844) }).strict()]),
  requiredAcceptance: z.array(text(1000)).min(1).max(40),
  acceptanceMode: z.literal("manual-until-scenario-available"),
}).strict().superRefine((sample, context) => {
  if (sample.seeds[1] !== sample.seeds[0] + 1) context.addIssue({ code: "custom", path: ["seeds"], message: "当前 runner 仅支持两个连续种子。" });
  if (sample.viewports[0].width === sample.viewports[1].width && sample.viewports[0].height === sample.viewports[1].height) context.addIssue({ code: "custom", path: ["viewports"], message: "两个视口不能重复。" });
  if (new Set(sample.requiredAcceptance.map(value => value.trim())).size !== sample.requiredAcceptance.length) context.addIssue({ code: "custom", path: ["requiredAcceptance"], message: "验收要求不能重复。" });
});

export const evaluationDatasetSchema = z.object({
  schemaVersion: z.literal(1),
  purpose: text(1000).optional(),
  cases: z.array(evaluationSampleSchema).min(1).max(30),
}).strict().superRefine((dataset, context) => {
  // Results must also remain unique on case-insensitive Windows filesystems.
  if (new Set(dataset.cases.map(sample => sample.id.toLowerCase())).size !== dataset.cases.length) context.addIssue({ code: "custom", path: ["cases"], message: "样本 id 不能重复（忽略大小写）。" });
});

export type EvaluationSample = z.infer<typeof evaluationSampleSchema>;
export type EvaluationDataset = z.infer<typeof evaluationDatasetSchema>;

export function parseEvaluationDataset(input: unknown): EvaluationDataset {
  const result = evaluationDatasetSchema.safeParse(input);
  if (!result.success) {
    // Neither untrusted values nor host paths belong in shareable diagnostics.
    throw new Error(`评测数据集不合法：${result.error.issues.map(issue => issue.path.join(".")).join("、")}。`);
  }
  return result.data;
}

/** Exact prompt, criteria, seeds and viewports form the gameplay contract. */
export async function evaluationSampleHash(sample: EvaluationSample): Promise<string> {
  const contract = JSON.stringify({
    prompt: sample.prompt,
    requiredAcceptance: sample.requiredAcceptance,
    seeds: sample.seeds,
    viewports: sample.viewports.map(({ width, height }) => ({ width, height })),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contract));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export const manualAcceptanceSchema = z.object({
  schemaVersion: z.literal(1),
  sampleId,
  sampleContractHash: hash,
  artifactHash: hash,
  method: z.literal("manual"),
  reviewer: text(200).nullable(),
  reviewedAt: z.iso.datetime({ offset: true }).nullable(),
  checks: z.array(z.object({
    requirement: text(1000),
    // Null is pending; strings/numbers are never interpreted as booleans.
    passed: z.boolean().nullable(),
    observation: text(4000).nullable(),
  }).strict()).min(1).max(40),
}).strict().superRefine((evidence, context) => {
  if (new Set(evidence.checks.map(check => check.requirement)).size !== evidence.checks.length) context.addIssue({ code: "custom", path: ["checks"], message: "人工验收项不能重复。" });
});

export type ManualAcceptanceEvidence = z.infer<typeof manualAcceptanceSchema>;
export type ManualAcceptanceStatus = "missing" | "legacy" | "stale" | "invalid" | "incomplete" | "complete";
export type ManualAcceptanceAssessment = {
  status: ManualAcceptanceStatus;
  requirementsPassed: boolean | null;
  diagnostics: string[];
};

export function createAcceptanceTemplate(sample: EvaluationSample, artifactHash: string, sampleContractHash: string): ManualAcceptanceEvidence {
  return manualAcceptanceSchema.parse({
    schemaVersion: 1, sampleId: sample.id, sampleContractHash, artifactHash,
    method: "manual", reviewer: null, reviewedAt: null,
    checks: sample.requiredAcceptance.map(requirement => ({ requirement, passed: null, observation: null })),
  });
}

/** A complete file records a human claim; it does not prove gameplay automatically. */
export function assessManualAcceptance(input: unknown, sample: EvaluationSample, artifactHash: string, sampleContractHash: string): ManualAcceptanceAssessment {
  if (input && typeof input === "object" && !Array.isArray(input) && !("schemaVersion" in input)
    && Object.values(input).every(value => typeof value === "boolean")) {
    return { status: "legacy", requirementsPassed: null, diagnostics: ["旧版 boolean 映射没有产物与需求绑定，不能作为本次人工验收。"] };
  }
  const parsed = manualAcceptanceSchema.safeParse(input);
  if (!parsed.success) return { status: "invalid", requirementsPassed: null, diagnostics: ["人工验收文件不符合 schemaVersion 1；字段与验收值必须严格符合格式。"] };
  const evidence = parsed.data;
  if (evidence.sampleId !== sample.id || evidence.artifactHash !== artifactHash || evidence.sampleContractHash !== sampleContractHash) {
    return { status: "stale", requirementsPassed: null, diagnostics: ["人工验收绑定的样本、产物或需求契约已变化，需要重新试玩。"] };
  }
  const requirements = new Set(sample.requiredAcceptance);
  if (!requirements.size || evidence.checks.length !== requirements.size || evidence.checks.some(check => !requirements.has(check.requirement))) {
    return { status: "invalid", requirementsPassed: null, diagnostics: ["人工验收必须恰好覆盖当前全部要求，不能缺项、重复或增加其他要求。"] };
  }
  if (evidence.reviewer === null || evidence.reviewedAt === null || evidence.checks.some(check => check.passed === null || check.observation === null)) {
    return { status: "incomplete", requirementsPassed: null, diagnostics: ["人工验收尚未填写完整的试玩人、时间、逐项 boolean 结论与观察记录。"] };
  }
  return { status: "complete", requirementsPassed: evidence.checks.every(check => check.passed === true), diagnostics: [] };
}
