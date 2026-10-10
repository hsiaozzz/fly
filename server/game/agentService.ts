import { invokeLLM } from "../_core/llm";
import { compileGameProject } from "../../shared/game/compiler";
import { gameSpecFromPrompt, normalizeGameSpec, validateGameSpec } from "../../shared/game/gamespec";
import { applyGamePatch, patchFromPrompt } from "../../shared/game/patches";
import { correctGameSpec, describeStop, type StopReason } from "../../shared/game/corrector";
import { runGates } from "../../shared/game/gates";
import type { BuildReport, GameFile, GamePatch, GameSpec } from "../../shared/game/types";
import { validateAndRepairProject } from "./buildAdapter";

export type GenerationResult = {
  spec: GameSpec;
  files: GameFile[];
  assistantMessage: string;
  trace: Array<{ agent: string; status: "done" | "repaired" | "fallback"; detail: string }>;
  build: BuildReport;
  /** Semantic-gate outcome. Absent only for callers that bypass the gates. */
  validation?: { stopReason: StopReason; attempts: number; failures: string[]; warnings: string[] };
};

function contentFrom(response: Awaited<ReturnType<typeof invokeLLM>>): string {
  const content = response.choices[0]?.message.content;
  return typeof content === "string" ? content : "";
}

async function askForGameSpec(prompt: string, existingSpec?: GameSpec): Promise<{ candidate: unknown; usedFallback: boolean }> {
  try {
    const response = await invokeLLM({
      messages: [
        { role: "system", content: "You are the GameSpec Generator in a safe game compiler. Return ONLY a JSON object (no markdown, no code fence) matching the supplied schema: game.title (short name), game.genre (only \"flappy\", \"shooter\", or \"runner\"), game.orientation (\"landscape\" or \"portrait\"), game.description, player.type/movement/color, mechanics (string array), entities (array of {id,type}), systems (string array), input (array of \"mouse\"/\"touch\"/\"keyboard\"), config.playerSpeed/gravity/obstacleGap/obstacleInterval/startingHealth (numbers). Never return source code." },
        { role: "user", content: `User request: ${prompt}\nExisting GameSpec when modifying: ${existingSpec ? JSON.stringify(existingSpec) : "none"}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1200,
    });
    return { candidate: JSON.parse(contentFrom(response)), usedFallback: false };
  } catch {
    return { candidate: gameSpecFromPrompt(prompt), usedFallback: true };
  }
}

/**
 * Ask the model to fix a spec that passed JSON Schema but failed a semantic
 * gate. The defect list is handed over verbatim: a reviser told *what* is
 * wrong fixes more than one told merely to "try again", and an unfixable spec
 * comes back unchanged fast enough for the loop to notice.
 */
async function askForSpecRevision(prompt: string, spec: GameSpec, failures: string[]): Promise<unknown> {
  const response = await invokeLLM({
    messages: [
      {
        role: "system",
        content: "You are repairing a GameSpec. Return ONLY the corrected JSON object (no markdown, no code fence) with the same schema. Change only what the listed defects require; keep every other value identical.",
      },
      {
        role: "user",
        content: `User request: ${prompt}\n\nCurrent GameSpec:\n${JSON.stringify(spec, null, 2)}\n\nDefects to fix:\n${failures.map(item => `- ${item}`).join("\n")}\n\nReturn the full corrected GameSpec.`,
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 1200,
  });
  return JSON.parse(contentFrom(response));
}

export async function generateGameFromPrompt(prompt: string, existingSpec?: GameSpec): Promise<GenerationResult> {
  const trace: GenerationResult["trace"] = [
    { agent: "Planner", status: "done", detail: "Classified the request into a supported 2D game template." },
  ];
  const planned = await askForGameSpec(prompt, existingSpec);
  trace.push({ agent: "GameSpec Generator", status: planned.usedFallback ? "fallback" : "done", detail: planned.usedFallback ? "LLM was unavailable; the deterministic planner produced a supported spec." : "Produced structured JSON rather than executable code." });
  const initialValidation = validateGameSpec(planned.candidate);
  const baseSpec = initialValidation.valid ? (planned.candidate as GameSpec) : normalizeGameSpec(planned.candidate);
  trace.push({ agent: "Validator", status: initialValidation.valid ? "done" : "repaired", detail: initialValidation.valid ? "GameSpec matches the schema." : "Normalized unsupported or incomplete values before compilation." });

  // Schema-valid is not playable. Run the semantic gates and, when they fail,
  // hand the defect list back to the model — but only inside a bounded loop
  // that can tell "still wrong" from "wrong in the same way".
  const outcome = await correctGameSpec(baseSpec, async (candidate, failures) =>
    normalizeGameSpec(await askForSpecRevision(prompt, candidate, failures)),
  );
  const spec = outcome.spec;
  trace.push({
    agent: "Semantic Gates",
    status: outcome.ok ? "done" : "repaired",
    detail: describeStop(outcome),
  });

  const compiled = compileGameProject(spec);
  const checked = validateAndRepairProject(compiled);
  const files = checked.files;
  const build: BuildReport = { ...checked.report, logs: ["[compiler] Selected a maintained Phaser template.", "[validator] GameSpec accepted by JSON Schema.", ...checked.report.logs] };
  trace.push({ agent: "Compiler", status: "done", detail: `Created ${files.length} project files from a maintained ${spec.game.genre} template.` });
  return { spec, files, build, trace, validation: { stopReason: outcome.stopReason, attempts: outcome.attempts, failures: outcome.gates.failures, warnings: outcome.gates.warnings }, assistantMessage: `I prepared **${spec.game.title}** as a ${spec.game.genre} game. The pipeline validated its GameSpec and compiled **${files.length} separate project files**. You can inspect, edit, preview, or download the Vite project now.` };
}

export function applyPromptPatch(prompt: string, spec: GameSpec, files: GameFile[]) {
  const patch: GamePatch = patchFromPrompt(prompt, spec.config.playerSpeed, spec.config.obstacleGap);
  const patchedFiles = applyGamePatch(files, patch);
  const nextSpec = normalizeGameSpec({ ...spec, config: {
    ...spec.config,
    playerSpeed: patch.operations.some(item => item.op === "modify" && item.target === "playerSpeed") ? Number((patch.operations.find(item => item.op === "modify" && item.target === "playerSpeed") as { value?: string | number } | undefined)?.value ?? spec.config.playerSpeed) : spec.config.playerSpeed,
    obstacleGap: patch.operations.some(item => item.op === "modify" && item.target === "obstacleGap") ? Number((patch.operations.find(item => item.op === "modify" && item.target === "obstacleGap") as { value?: string | number } | undefined)?.value ?? spec.config.obstacleGap) : spec.config.obstacleGap,
  } });
  const checked = validateAndRepairProject(patchedFiles);
  return { patch, files: checked.files, spec: nextSpec, build: { ...checked.report, logs: ["[patch] Applied a targeted file operation.", "[validator] Updated GameSpec is valid.", ...checked.report.logs] } };
}
