import { z } from "zod";

/** User requirements remain separate from defaults inferred by the creator. */
export type AcceptanceCriterion = {
  id: string;
  kind: "core_gameplay" | "quantity" | "controls";
  requirement: string;
  source: "user";
  evidence: "browser" | "manual";
  target?: string;
  value?: number;
};

export type GameDesign = {
  schemaVersion: "1.0";
  originalPrompt: string;
  answers: Record<string, string>;
  coreLoop: { request: string };
  inferredDefaults: string[];
  acceptance: AcceptanceCriterion[];
  changeRequests: string[];
};

export const DESIGN_FILE = "arcane.design.json";

export const gameDesignSchema = z.object({
  schemaVersion: z.literal("1.0"), originalPrompt: z.string(), answers: z.record(z.string(), z.string()),
  coreLoop: z.object({ request: z.string() }).strict(), inferredDefaults: z.array(z.string()), changeRequests: z.array(z.string()),
  acceptance: z.array(z.object({ id: z.string().min(1), kind: z.enum(["core_gameplay", "quantity", "controls"]), requirement: z.string().min(1), source: z.literal("user"), evidence: z.enum(["browser", "manual"]), target: z.string().optional(), value: z.number().finite().optional() }).strict()).min(1),
}).strict().superRefine((design, context) => {
  if (new Set(design.acceptance.map(item => item.id)).size !== design.acceptance.length) context.addIssue({ code: "custom", path: ["acceptance"], message: "验收项id重复。" });
});

export function validateGameDesign(input: unknown): { valid: boolean; errors: string[]; design: GameDesign | null } {
  const result = gameDesignSchema.safeParse(input);
  return result.success ? { valid: true, errors: [], design: result.data } : { valid: false, errors: result.error.issues.map(issue => `${issue.path.join(".")}：${issue.message}`), design: null };
}

function requirements(prompt: string, prefix: string): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = [{
    id: `${prefix}-gameplay`, kind: "core_gameplay", requirement: prompt,
    source: "user", evidence: "manual",
  }];
  // Preserve explicit numeric phrases verbatim; do not guess what a number means.
  const quantities = prompt.matchAll(/(?:\d{1,4}\s*(?:条生命|条命|(?:个|只|枚|颗|条|次|关)[\p{Script=Han}]{0,8}|秒|分钟|apples?|lives?|seconds?|levels?)|(?:生命|命数|血量|lives?|health)\s*[:：为是]?\s*\d{1,4})/giu);
  for (const match of quantities) {
    const numeric = match[0].match(/\d+/)?.[0];
    if (!numeric) continue;
    criteria.push({ id: `${prefix}-quantity-${criteria.length}`, kind: "quantity", requirement: match[0], source: "user", evidence: "manual", target: match[0].replace(numeric, "").trim(), value: Number(numeric) });
  }
  const controls = prompt.match(/空格|方向键|鼠标|触摸|点击|拖动|WASD|arrow keys?|space(?:bar)?/gi);
  for (const control of new Set(controls ?? [])) {
    criteria.push({ id: `${prefix}-controls-${criteria.length}`, kind: "controls", requirement: `按用户要求支持${control}`, source: "user", evidence: "browser", target: control });
  }
  return criteria;
}

export function createGameDesign(prompt: string, answers: Record<string, string> = {}): GameDesign {
  return {
    schemaVersion: "1.0", originalPrompt: prompt, answers: { ...answers }, coreLoop: { request: prompt },
    inferredDefaults: ["未指定的视觉风格、难度与平台由生成器选择；这些默认项不是用户验收要求。"],
    acceptance: [...requirements(prompt, "request"), ...Object.entries(answers).flatMap(([id, answer]) => requirements(answer, `answer-${id}`))],
    changeRequests: [],
  };
}

export function readGameDesign(files: { path: string; content: string }[]): GameDesign | null {
  try {
    const file = files.find(item => item.path === DESIGN_FILE);
    if (!file) return null;
    return validateGameDesign(JSON.parse(file.content)).design;
  } catch { return null; }
}

export function reviseGameDesign(design: GameDesign, prompt: string): GameDesign {
  const changeRequests = [...design.changeRequests, prompt];
  return { ...design, changeRequests, acceptance: [...design.acceptance, ...requirements(prompt, `change-${changeRequests.length}`)] };
}
