import { invokeLLM } from "../_core/llm";
import { correctWith } from "../../shared/game/corrector";
import { runSourceGates } from "../../shared/game/sourceGates";
import { artifactDigest, languageForPath, safeGamePath, snapshotText, validateArtifact } from "../../shared/game/artifact";
import { createGameDesign, DESIGN_FILE, readGameDesign, reviseGameDesign, type GameDesign } from "../../shared/game/design";
import { checkJavaScriptSyntax } from "./syntax";
import { bundleGameArtifact } from "../../shared/game/bundle";
import { BROWSER_GAME_RUNTIME_JS, BROWSER_RUNTIME_FILE, BROWSER_RUNTIME_GUIDANCE } from "../../shared/game/browserRuntime";
import type {
  BuildReport,
  ClarifyDecision,
  ClarifyResult,
  FreeGenResult,
  GameArtifact,
  GameFile,
  TraceStep,
  ValidationSummary,
} from "../../shared/game/types";

/**
 * Free-form generation pipeline.
 *
 * Replaces the three-template compiler with direct LLM-authored game
 * projects:
 *   1. Planner  — interprets the prompt; asks the user for missing context.
 *   2. Generator — writes a complete multi-file game (index.html must be a
 *                  self-contained playable artifact for the sandbox preview).
 *   3. Validator — enforces safety bounds (file count / size / paths) and
 *                  requires index.html. No genre whitelist anymore.
 */

const SYSTEM_PLANNER = `You are the planning agent of a safe game compiler. Your job: read the player's request and decide whether it is clear enough to start creating the game.

A request is CLEAR when it names a game TYPE (跑酷/射击/解谜/塔防/休闲/接物等) OR describes the core action (接住掉落的苹果、左右移动、跳跃躲避、点击配对…). If either exists, do NOT ask any questions — infer the remaining details with sensible defaults (platform, art style, difficulty) and proceed.

Ask for clarification ONLY when the request has NO usable creative direction at all, e.g.:
- No game type AND no core action ("帮我做个游戏", "随便做个东西")
- Contradictory requirements
- The request is a fragment with no meaning

Return ONLY a JSON object with this shape:
{"intent": "<one-sentence interpretation of the request, in Chinese>", "needClarification": true|false, "questions": [{"id":"q1","question":"<question in Chinese>","hint":"<optional short hint>"}]}
When needClarification is false, questions must be an empty array. Never return source code.`;

const SYSTEM_GENERATOR = `You are the Game Creator agent in a game compiler. You write complete, working HTML5 games from a natural-language request. NO template matching: every request gets a custom game.

Rules:
1. Return ONLY a JSON object, no markdown, no code fences. For patch requests use the game_patch shape specified in the user message:
{"title":"<game title, max 40 chars>","description":"<one or two sentences in Chinese>","controls":["<control hint in Chinese>"],"files":[{"path":"index.html","content":"<full file content>"}, ...]}
2. "files" must contain at least "index.html" — a COMPLETE, self-contained playable game. It MUST run when opened standalone in a browser.
3. Implement the game with plain JavaScript + Canvas2D (or DOM) inline in index.html whenever possible, so it works offline and inside a sandboxed iframe with no network. Do not use any CDN, external URL, package imports, or network dependencies.
4. You MAY split code into extra files (e.g. src/main.js, src/style.css) for maintainability, but index.html must reference them correctly. Keep the file count between 1 and 12.
5. Layout & feel: the game canvas must fill the whole preview window — size it to its container (use 100vw/100vh or a resize handler on window resize), never leave large empty margins. Use a dark theme with accent colors. Show a HUD (score/health/timer). Include a start/help overlay that explains the goal and win condition, then begin on click. On win/lose show a clear result overlay with a restart button.
6. Interaction feedback: highlight the hovered cell/position, animate stone/piece placement (scale or pop), and when the win condition is met, highlight the winning line / sequence clearly.
7. Escape content safely: no "</script>" sequence inside inline JS strings (write it as "<\\/script>"). Do not use TypeScript — plain JS.
8. Description and controls in Chinese unless the user wrote in another language.
9. CRITICAL — follow the user's core gameplay exactly. If they ask to catch falling apples with a basket, implement catching falling apples with a basket: same objects, same action, same win condition. NEVER silently swap in a different game. If the request mentions specific numbers (10 apples, 3 lives), honor them in the code.
10. Write compact code: index.html should stay under ~350 lines. The whole JSON response must be complete and end with a closing brace — do not get truncated. Prefer concise helper functions over verbose repetition.`;

const CREATOR_PROMPT = SYSTEM_GENERATOR + "\n\n" + BROWSER_RUNTIME_GUIDANCE + `
Optional editable parameters may be stored in arcane.config.json with {"schemaVersion":1,"parameters":[{"id":"speed","label":"移动速度","type":"number","value":200,"min":50,"max":600,"step":10}]}. Allowed parameter types: number,color,boolean. Reference and read this data explicitly via fetch('arcane.config.json') with a local default; do not leave an unused config file. Put only real, supported gameplay/appearance parameters here. The exported bundled HTML provides offline local-file loading.`;

export { validateArtifact } from "../../shared/game/artifact";

export type GenerationOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Maximum total tokens for this job, shared by planning/generation/repair. */
  tokenBudget?: number;
  onStage?: (step: TraceStep) => void;
  onUsage?: (tokens: number) => void;
  decision?: ClarifyDecision;
  existingArtifact?: GameArtifact;
};

export function contentFrom(response: Awaited<ReturnType<typeof invokeLLM>>): string {
  const content = response.choices[0]?.message.content;
  return typeof content === "string" ? content : "";
}

class JsonResponseError extends Error {}
export class GenerationBudgetError extends Error {}
type TokenLedger = { limit: number; spent: number; reserved: number };
const JOB_BUDGET = Symbol("generation-token-budget");
type InternalOptions = GenerationOptions & { [JOB_BUDGET]?: TokenLedger };

function configuredTokenBudget(): number {
  const raw = process.env.GENERATION_TOKEN_RESERVE;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : 64_000;
}

/** No brace repair: braces in generated JS strings cannot safely be counted. */
export function parseJsonObject(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new JsonResponseError("模型未返回完整JSON对象，请重新生成紧凑且完整的代码。"); }
}

function bounded(options: GenerationOptions): GenerationOptions {
  let ledger = (options as InternalOptions)[JOB_BUDGET];
  if (!ledger) {
    const configured = configuredTokenBudget(), limit = options.tokenBudget ?? configured;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > configured) throw new GenerationBudgetError(`任务token预算必须为1–${configured}；提高预算需调整服务端GENERATION_TOKEN_RESERVE及全局限额。`);
    ledger = { limit, spent: 0, reserved: 0 };
  }
  const deadline = AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs ?? 240_000, 300_000)));
  // Enumerable Symbol survives opts spreads across nested planning calls, but
  // cannot be supplied through JSON requests or serialized into model prompts.
  return { ...options, [JOB_BUDGET]: ledger, signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline } as InternalOptions;
}

/** Create once per job when planning and generation are invoked separately. */
export function createGenerationJobOptions(options: GenerationOptions = {}): GenerationOptions {
  return bounded(options);
}

async function askOnce(messages: Parameters<typeof invokeLLM>[0]["messages"], maxTokens: number, options: GenerationOptions): Promise<unknown> {
  options.signal?.throwIfAborted();
  const ledger = (options as InternalOptions)[JOB_BUDGET]!;
  // UTF-8 bytes conservatively bound prompt tokens; include serialized role,
  // content delimiters, per-message overhead and the maximum completion.
  const estimated = Buffer.byteLength(JSON.stringify(messages), "utf8") + messages.length * 32 + 256 + maxTokens;
  const remaining = ledger.limit - ledger.spent - ledger.reserved;
  if (estimated > remaining) throw new GenerationBudgetError(`本次调用的保守上界为${estimated} tokens，超过任务剩余${Math.max(0, remaining)} tokens；调用尚未发送。请缩小当前项目源码，或提高服务端GENERATION_TOKEN_RESERVE并检查全局限额。`);
  ledger.reserved += estimated;
  let charged = estimated;
  try {
    // Transport errors can happen after the provider already billed a POST.
    // Keep retries at this layer so each attempted call has its own reservation.
    const response = await invokeLLM({ messages, response_format: { type: "text" }, max_tokens: maxTokens, maxRetries: 0, signal: options.signal, timeoutMs: options.timeoutMs });
    const actual = response.usage?.total_tokens;
    if (typeof actual === "number" && Number.isFinite(actual) && actual >= 0) charged = Math.ceil(actual);
    options.signal?.throwIfAborted();
    const reason = response.choices[0]?.finish_reason;
    if (reason === "length") throw new JsonResponseError("模型输出被长度上限截断；必须重新返回更紧凑的完整JSON，不能把截断代码当成成品。");
    if (reason && reason !== "stop") throw new Error(`模型未正常完成：${reason}`);
    return parseJsonObject(contentFrom(response));
  } finally {
    ledger.reserved -= estimated;
    ledger.spent += charged;
    // Failed requests/missing provider usage keep the conservative charge.
    options.onUsage?.(charged);
  }
}

async function askRepair(messages: Parameters<typeof invokeLLM>[0]["messages"], options: GenerationOptions): Promise<unknown> {
  try { return await askOnce(messages, 8000, options); }
  catch (error) {
    options.signal?.throwIfAborted();
    if (!(error instanceof JsonResponseError)) throw error;
    return askOnce([...messages, { role: "user", content: `${error.message} Return the entire corrected artifact again as compact valid JSON.` }], 8000, options);
  }
}

const ACTION_HINTS = /接住|接苹果|吃掉|躲避|跳跃|射击|开火|移动|配对|翻牌|放置|种菜|合成|消除|战斗|逃出|收集|点击|拖动|驾驶|闯关|保护|防御|进攻|逃离|catch|jump|shoot|collect|match|click/i;
const GENRE_HINTS = /跑酷|射击|塔防|解谜|赛车|格斗|rpg|休闲|动作|益智|音乐|策略|模拟|体育|迷宫|消除|roguelike|闯关|剧情|对战|runner|shooter|puzzle|chess|platformer|racing/i;

export async function clarifyRequest(prompt: string, answers?: Record<string, string>, options: GenerationOptions = {}): Promise<ClarifyResult> {
  const opts = bounded(options), trace: TraceStep[] = [];
  const stage = (step: TraceStep) => { trace.push(step); opts.onStage?.(step); };
  stage({ agent: "Planner", status: "running", detail: "正在理解游戏目标与操作方式。" });
  let decision: ClarifyDecision;
  if (Object.keys(answers ?? {}).length || ACTION_HINTS.test(prompt) || GENRE_HINTS.test(prompt)) {
    decision = { intent: `创作一个基于「${prompt.slice(0, 80)}」的游戏`, needClarification: false, questions: [] };
  } else {
    let parsed: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { parsed = await askOnce([{ role: "system", content: SYSTEM_PLANNER }, { role: "user", content: `Player request: ${prompt}` }], 800, opts); break; }
      catch (error) { opts.signal?.throwIfAborted(); if (!(error instanceof JsonResponseError) || attempt === 1) throw error; }
    }
    const raw = parsed as Partial<ClarifyDecision>;
    const questions = Array.isArray(raw.questions) ? raw.questions.filter(q => q && typeof q.question === "string" && q.question.trim()).slice(0, 4).map((q, i) => ({ id: typeof q.id === "string" ? q.id.slice(0, 80) : `q${i + 1}`, question: q.question.slice(0, 500), ...(typeof q.hint === "string" ? { hint: q.hint.slice(0, 500) } : {}) })) : [];
    decision = { intent: typeof raw.intent === "string" && raw.intent.trim() ? raw.intent.trim().slice(0, 500) : prompt.slice(0, 200), needClarification: raw.needClarification === true && questions.length > 0, questions: raw.needClarification === true ? questions : [] };
  }
  stage({ agent: "Planner", status: decision.needClarification ? "clarify" : "done", detail: `理解意图：${decision.intent}` });
  return { decision, trace };
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("修改响应必须为对象。");
  return input as Record<string, unknown>;
}

/** Atomic in-memory patch; no operation can partially change the base snapshot. */
export async function applyGamePatch(base: GameArtifact, input: unknown): Promise<GameArtifact> {
  const patch = record(input), files = new Map(base.files.map(file => [file.path, { ...file }]));
  if (patch.type === "game_patch") {
    if (typeof patch.baseHash !== "string" || patch.baseHash !== await artifactDigest(base)) throw new Error("修改的baseHash与当前版本不匹配，请基于最新快照重新生成。");
    if (!Array.isArray(patch.operations) || !patch.operations.length || patch.operations.length > 80) throw new Error("修改必须包含1–80个明确操作。");
    for (const raw of patch.operations) {
      const operation = record(raw), path = safeGamePath(operation.file);
      if ([DESIGN_FILE, BROWSER_RUNTIME_FILE].includes(path) || [DESIGN_FILE, BROWSER_RUNTIME_FILE].includes(String(operation.to))) throw new Error("设计、验收及稳定运行工具由服务端维护，模型不可修改。");
      const present = files.has(path);
      if (operation.op === "delete") { if (!present) throw new Error(`删除目标不存在：${path}`); files.delete(path); }
      else if (operation.op === "rename") {
        const to = safeGamePath(operation.to);
        if (!present || files.has(to)) throw new Error(`重命名目标不存在或目标路径已占用：${path} → ${to}`);
        const previous = files.get(path)!; files.delete(path); files.set(to, { ...previous, path: to, language: languageForPath(to) });
      } else if (operation.op === "create" || operation.op === "modify") {
        if (operation.op === "create" && present || operation.op === "modify" && !present) throw new Error(`文件操作与现有路径不匹配：${operation.op} ${path}`);
        if (typeof operation.content !== "string") throw new Error(`缺少完整文件内容：${path}`);
        files.set(path, { path, content: operation.content, language: languageForPath(path) });
      } else throw new Error(`未知修改操作：${String(operation.op)}`);
    }
  } else {
    // Compatibility with old responses, while keeping validation strict.
    if (!Array.isArray(patch.files) || !patch.files.length) throw new Error("修改响应没有提供任何文件。");
    const seen = new Set<string>();
    for (const raw of patch.files) {
      const file = record(raw), path = safeGamePath(file.path);
      if ([DESIGN_FILE, BROWSER_RUNTIME_FILE].includes(path) || seen.has(path.toLowerCase())) throw new Error(`重复或受保护的修改路径：${path}`);
      seen.add(path.toLowerCase());
      if (typeof file.content !== "string") throw new Error(`文件内容无效：${path}`);
      files.set(path, { path, content: file.content, language: languageForPath(path) });
    }
  }
  const checked = validateArtifact({ title: patch.title ?? base.title, description: patch.description ?? base.description, controls: patch.controls ?? base.controls, files: [...files.values()] });
  if (!checked.valid || !checked.artifact) throw new Error(checked.errors.join("; "));
  if (snapshotText(checked.artifact) === snapshotText(base)) throw new Error("修改未改变任何内容。");
  return checked.artifact;
}

function withDesign(artifact: GameArtifact, design: GameDesign): GameArtifact {
  const files = artifact.files.filter(file => file.path !== DESIGN_FILE);
  const runtimeRequested = files.find(file => file.path === "index.html")?.content.includes(BROWSER_RUNTIME_FILE);
  if (runtimeRequested) {
    const existing = files.findIndex(file => file.path === BROWSER_RUNTIME_FILE);
    const runtime: GameFile = { path: BROWSER_RUNTIME_FILE, content: BROWSER_GAME_RUNTIME_JS, language: "javascript" };
    if (existing >= 0) files[existing] = runtime; else files.push(runtime);
  }
  const checked = validateArtifact({ ...artifact, files: [...files, { path: DESIGN_FILE, content: JSON.stringify(design, null, 2), language: "json" }] });
  if (!checked.valid || !checked.artifact) throw new Error(checked.errors.join("; "));
  return checked.artifact;
}

function gateReport(artifact: GameArtifact) {
  const source = runSourceGates(artifact.files), syntax = checkJavaScriptSyntax(artifact.files);
  let bundle: import("../../shared/game/types").GateCheck;
  try { const result = bundleGameArtifact(artifact); bundle = { name: "project_bundle", label: "项目依赖", status: "pass", detail: `离线入口与${result.referencedFiles.length}个依赖可打包。` }; }
  catch (error) { bundle = { name: "project_bundle", label: "项目依赖", status: "fail", detail: error instanceof Error ? error.message : "打包失败。", hint: "修复依赖引用，移除不支持的网络或包依赖。" }; }
  const checks = [...source.checks, syntax, bundle];
  return { checks, failures: checks.filter(check => check.status === "fail").map(check => `${check.label}：${check.detail}${check.hint ? ` ${check.hint}` : ""}`), warnings: source.warnings };
}

async function generateArtifact(prompt: string, design: GameDesign, options: GenerationOptions, stage: (step: TraceStep) => void, existing?: GameArtifact): Promise<{ artifact: GameArtifact; validation: ValidationSummary }> {
  const baseHash = existing ? await artifactDigest(existing) : undefined;
  const request = existing
    ? `Modify the current project for this request: ${prompt}\nReturn {"type":"game_patch","baseHash":"${baseHash}","operations":[{"op":"modify","file":"index.html","content":"<complete content>"}]}. Supported ops: create,modify(content required),delete,rename(to required). Include at least one real change. Optional title/description/controls preserve metadata when omitted. Do not modify ${DESIGN_FILE}.\nCurrent snapshot:\n${JSON.stringify(existing)}`
    : `Player request: ${prompt}`;
  const designContext = `\nUser requirements and acceptance criteria (preserve them exactly; defaults are only suggestions):\n${JSON.stringify(design)}\nDo not author ${DESIGN_FILE}; the server adds it.`;
  let artifact: GameArtifact | null = null, errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    options.signal?.throwIfAborted();
    stage({ agent: "Game Creator", status: "running", detail: attempt === 1 ? "正在生成可运行的游戏代码。" : `重新生成完整响应：${errors.join("; ")}` });
    try {
      const parsed = await askOnce([{ role: "system", content: CREATOR_PROMPT }, { role: "user", content: request + designContext + (errors.length ? `\nThe previous response failed: ${errors.join("; ")}. Return a complete corrected response.` : "") }], 8000, options);
      const checked = existing ? { valid: true, errors: [], artifact: await applyGamePatch(existing, parsed) } : validateArtifact(parsed);
      if (!checked.valid || !checked.artifact) throw new JsonResponseError(checked.errors.join("; "));
      artifact = withDesign(checked.artifact, design);
      stage({ agent: "Validator", status: "done", detail: "文件路径、内容、体积及入口校验通过。" });
      break;
    } catch (error) {
      options.signal?.throwIfAborted();
      errors = [error instanceof Error ? error.message : "模型响应无效。"];
      stage({ agent: "Validator", status: "failed", detail: errors[0] });
      // API outages are not a reason to spend another full generation call.
      if (error instanceof GenerationBudgetError || !(error instanceof JsonResponseError) && !existing) throw error;
    }
  }
  if (!artifact) throw new Error(`生成未通过产物校验：${errors.join("; ")}`);
  stage({ agent: "Game Creator", status: "done", detail: `已生成${artifact.files.length}个文件，开始检查源码。` });
  const outcome = await correctWith<GameArtifact>({
    initial: artifact, defects: candidate => gateReport(candidate).failures, maxAttempts: 2,
    revise: async (candidate, defects) => {
      options.signal?.throwIfAborted();
      stage({ agent: "Repair", status: "running", detail: `正在修复${defects.length}项实际源码问题。` });
      const parsed = await askRepair([{ role: "system", content: CREATOR_PROMPT }, { role: "user", content: `Original request: ${prompt}${designContext}\nReturn the COMPLETE corrected artifact JSON, containing every authored file in full. Omit managed ${DESIGN_FILE} and ${BROWSER_RUNTIME_FILE}; the server preserves these. Fix these diagnostics:\n${defects.join("\n")}\nCurrent candidate to repair (do not restore an earlier snapshot):\n${JSON.stringify(candidate)}` }], options);
      const checked = validateArtifact(parsed);
      if (!checked.valid || !checked.artifact) throw new Error(checked.errors.join("; "));
      return withDesign(checked.artifact, design);
    },
  });
  options.signal?.throwIfAborted();
  const report = gateReport(outcome.candidate);
  const validation: ValidationSummary = { stopReason: outcome.stopReason, attempts: outcome.attempts, failures: report.failures, warnings: [...report.warnings, ...(outcome.detail ? [`修复未完成：${outcome.detail}`] : [])], checks: report.checks };
  stage({ agent: "Playability Gates", status: report.failures.length ? "failed" : outcome.attempts ? "repaired" : "done", detail: report.failures.length ? `${report.failures.length}项源码检查失败（${outcome.stopReason}），已保留诊断。` : "源码与语法检查通过，浏览器行为及用户玩法要求待验收。", checks: report.checks });
  return { artifact: outcome.candidate, validation };
}

function buildReport(validation: ValidationSummary): BuildReport {
  return {
    status: validation.failures.length ? "failed" : "pending", attempts: 1 + validation.attempts, repairApplied: validation.attempts > 0,
    logs: ["[static] 产物结构与JavaScript语法已检查。", ...validation.failures.map(failure => `[FAIL] ${failure}`), ...validation.warnings.map(warning => `[WARN] ${warning}`), "[browser] 浏览器工程、输入与用户验收尚未执行；静态通过不表示已经可玩。"],
  };
}

export async function freeGenerate(prompt: string, answers?: Record<string, string>, options: GenerationOptions = {}): Promise<FreeGenResult> {
  const opts = bounded(options), trace: TraceStep[] = [];
  const stage = (step: TraceStep) => { trace.push(step); opts.onStage?.(step); };
  const decision = opts.decision ?? (await clarifyRequest(prompt, answers, { ...opts, onStage: stage })).decision;
  if (decision.needClarification) throw new Error("需求需要澄清，请先回答规划问题。");
  if (opts.decision) stage({ agent: "Planner", status: "done", detail: `理解意图：${decision.intent}` });
  const design = createGameDesign(prompt, answers);
  stage({ agent: "Design", status: "done", detail: `已记录${design.acceptance.length}项用户验收要求。` });
  const context = Object.keys(answers ?? {}).length ? `\nPlayer answers: ${JSON.stringify(answers)}` : "";
  const { artifact, validation } = await generateArtifact(prompt + context, design, opts, stage);
  const build = buildReport(validation);
  const assistantMessage = `已生成 **${artifact.title}**（${artifact.files.length}个文件）。${validation.failures.length ? "源码检查仍有问题，请查看诊断。" : "源码检查通过，浏览器与玩法验收待完成。"}${artifact.controls.length ? `\n\n操作：${artifact.controls.join(" · ")}` : ""}`;
  return { artifact, trace, build, assistantMessage, intent: decision.intent, validation, design };
}

export async function freePatch(existing: GameFile[], prompt: string, options: GenerationOptions = {}): Promise<FreeGenResult> {
  const opts = bounded(options), trace: TraceStep[] = [];
  const stage = (step: TraceStep) => { trace.push(step); opts.onStage?.(step); };
  const base = opts.existingArtifact ?? { title: /<title>([^<]*)<\/title>/i.exec(existing.find(file => file.path === "index.html")?.content ?? "")?.[1] || "Updated Game", description: "", controls: [], files: existing };
  const validated = validateArtifact(base);
  if (!validated.artifact || !validated.valid) throw new Error(validated.errors.join("; "));
  stage({ agent: "Planner", status: "done", detail: "已载入当前快照及修改要求。" });
  const previousDesign = readGameDesign(base.files);
  if (base.files.some(file => file.path === DESIGN_FILE) && !previousDesign) throw new Error("当前设计契约格式无效，请先修复arcane.design.json，避免丢失原始玩法要求。");
  const design = previousDesign ? reviseGameDesign(previousDesign, prompt) : createGameDesign(prompt);
  const { artifact, validation } = await generateArtifact(prompt, design, opts, stage, validated.artifact);
  return { artifact, trace, build: buildReport(validation), assistantMessage: `已生成 **${artifact.title}** 的修改版本。${validation.failures.length ? "源码检查仍有问题。" : "源码检查通过，浏览器验收待完成。"}`, validation, design };
}

