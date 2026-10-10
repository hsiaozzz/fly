import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
const base = { id, label: z.string().trim().min(1).max(80) };
const parameterSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("number"), value: z.number().finite(), min: z.number().finite(), max: z.number().finite(), step: z.number().positive().finite().optional() }).strict(),
  z.object({ ...base, type: z.literal("color"), value: z.string().regex(/^#[0-9a-f]{6}$/i) }).strict(),
  z.object({ ...base, type: z.literal("boolean"), value: z.boolean() }).strict(),
]);
export const gameConfigSchema = z.object({ schemaVersion: z.literal(1), parameters: z.array(parameterSchema).min(1).max(24) }).strict().superRefine((config, context) => {
  const seen = new Set<string>();
  config.parameters.forEach((parameter, index) => {
    if (seen.has(parameter.id)) context.addIssue({ code: "custom", path: ["parameters", index, "id"], message: "参数 id 重复。" });
    seen.add(parameter.id);
    if (parameter.type === "number" && (parameter.min > parameter.max || parameter.value < parameter.min || parameter.value > parameter.max)) context.addIssue({ code: "custom", path: ["parameters", index, "value"], message: "参数值必须在 min/max 范围内。" });
  });
});
export type GameConfig = z.infer<typeof gameConfigSchema>;
export type GameParameter = GameConfig["parameters"][number];
export function validateGameConfig(input: unknown): { valid: boolean; errors: string[]; config: GameConfig | null } {
  const result = gameConfigSchema.safeParse(input);
  return result.success ? { valid: true, errors: [], config: result.data } : { valid: false, errors: result.error.issues.map(issue => `${issue.path.join(".")}：${issue.message}`), config: null };
}
