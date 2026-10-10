import type { GameFile } from "./types";

/**
 * Static playability gates for LLM-authored game source.
 *
 * `validateArtifact` answers "is this file tree safe?" — file count, byte
 * size, path traversal. It does not answer whether the thing inside is a
 * game. These gates collect static implementation evidence without executing source. Browser verification is still required:
 *
 *   - no `<canvas>` / render target        → nothing to look at
 *   - no `requestAnimationFrame`           → nothing updates (a still image)
 *   - no input listener                    → nothing to do
 *   - unescaped `</script>` inside JS      → the page truncates mid-code
 *   - leftover `TODO` / placeholder prose  → the model gave up and shipped it
 *
 * This is the part of GameFactory-3A's acceptance checklist that is
 * *deterministic*. Its 7-row review table also includes "does the style
 * match" and "does it look fun", which genuinely need a model. Splitting the
 * two is the point: a defect that can be caught by a regex should never cost
 * a VLM call, and never depend on one to be caught at all.
 *
 * Severity is deliberate. `fail` blocks generation and triggers a revision
 * with the defect list attached. `warn` is surfaced but never blocks: a
 * sandbox toy with no win condition is a legitimate game, and a gate that
 * guesses wrong would reject correct output — the mistake made by an earlier
 * version of the spec gates, which failed every maintained flappy template.
 */

export type GateStatus = "pass" | "warn" | "fail";

export type SourceCheck = {
  name: string;
  /** Short Chinese label for the UI. */
  label: string;
  status: GateStatus;
  detail: string;
  /** What the author (human or model) should change. Present when not passing. */
  hint?: string;
};

export type SourceGateReport = {
  /** True when no check failed. Warnings do not block. */
  ok: boolean;
  checks: SourceCheck[];
  failures: string[];
  warnings: string[];
};

import { activeScripts, calls, codeOnly, executableTokens, hasEventDrivenRender, htmlSource } from "./sourceEvidence";

function combined(files: GameFile[]): string {
  return `${htmlSource(files)}\n${activeScripts(files).scripts.map(script => script.content).join("\n")}`;
}

function hasInput(files: GameFile[]): boolean {
  const tokens = executableTokens(files);
  return calls(tokens, "addEventListener", /^(?:key(?:down|up|press)|pointer(?:down|up|move)|mouse(?:down|up|move)|click|touch(?:start|move|end))$/i)
    || /\bon(?:keydown|keyup|keypress|pointerdown|mousedown|click|touchstart)\s*=/.test(codeOnly(files))
    || /\bon(?:click|keydown|pointerdown)\s*=/i.test(htmlSource(files).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ""));
}

const check = (
  name: string,
  label: string,
  status: GateStatus,
  detail: string,
  hint?: string,
): SourceCheck => (hint ? { name, label, status, detail, hint } : { name, label, status, detail });

/** A game with nothing to draw on is a blank page. */
export function checkRenderTarget(files: GameFile[]): SourceCheck {
  const tokens = executableTokens(files);
  const markup = htmlSource(files).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  const hasCanvas = /<canvas[\s>]|<svg[\s>]/i.test(markup)
    || calls(tokens, "createElement", /^(?:canvas|div|button|svg|table)$/i)
    || calls(tokens, "getElementById") || calls(tokens, "querySelector") || calls(tokens, "querySelectorAll");
  return hasCanvas
    ? check("render_target", "渲染目标", "pass", "检测到 canvas 或渲染容器。")
    : check(
        "render_target",
        "渲染目标",
        "fail",
        "源码中没有 canvas，也没有任何渲染容器。",
        "用 <canvas> 绘制游戏画面，或至少创建一个 DOM 容器来承载游戏元素。",
      );
}

/** Games may update continuously or in response to turns and pointer events. */
export function checkGameLoop(files: GameFile[]): SourceCheck {
  const tokens = executableTokens(files);
  const hasLoop = calls(tokens, "requestAnimationFrame") || calls(tokens, "setInterval");
  const eventDriven = hasEventDrivenRender(files);
  return hasLoop || eventDriven
    ? check("game_loop", "状态更新", "pass", hasLoop ? "检测到动画/定时循环；输入效果仍需浏览器验证。" : "检测到事件驱动的画面更新，适用于棋类与回合制游戏。")
    : check("game_loop", "状态更新", "fail", "没有动画循环，也没有输入驱动的渲染更新证据。", "实现动画循环，或在用户事件处理后更新DOM/画布。");
}

/** No input listener means nothing the player does has an effect. */
export function checkInputBinding(files: GameFile[]): SourceCheck {
  const hasListener = hasInput(files);
  return hasListener
    ? check("input_binding", "输入响应", "pass", "检测到键盘、鼠标或触摸事件监听。")
    : check(
        "input_binding",
        "输入响应",
        "fail",
        "没有任何键盘 / 鼠标 / 触摸监听，玩家无法操作。",
        "至少绑定一种输入：keydown（键盘）、pointerdown（鼠标/触摸）或 click。",
      );
}

/**
 * An unescaped `</script>` inside inline JS closes the tag early and the rest
 * of the game is parsed as HTML text. The page loads, the console is quiet,
 * and nothing works — the exact failure mode "no errors in the log" misses.
 */
export function checkScriptIntegrity(files: GameFile[]): SourceCheck {
  const html = htmlSource(files);
  const openTags = (html.match(/<script[\s>]/gi) ?? []).length;
  const closeTags = (html.match(/<\/script\s*>/gi) ?? []).length;
  if (closeTags > openTags) {
    return check(
      "script_integrity",
      "脚本完整性",
      "fail",
      `</script> 出现 ${closeTags} 次但开标签只有 ${openTags} 个，脚本被提前截断。`,
      "把 JS 字符串里的 </script> 写成 <\\/script>，避免提前闭合标签。",
    );
  }
  if (openTags > closeTags) {
    return check(
      "script_integrity",
      "脚本完整性",
      "fail",
      `<script> 开标签有 ${openTags} 个但只闭合了 ${closeTags} 个。`,
      "补齐 </script> 结束标签。",
    );
  }
  const missing = activeScripts(files).missing;
  if (missing.length) return check("script_integrity", "脚本完整性", "fail", `入口引用了不存在的脚本：${missing.join(", ")}`, "补齐依赖或移除失效引用。");
  return check("script_integrity", "脚本完整性", "pass", "script 标签配对正常，本地脚本引用存在；语法另行验证。");
}

/**
 * Placeholder prose is the model quietly giving up. It parses, it loads, and
 * it ships — the most expensive kind of defect, because it looks finished.
 */
export function checkNoPlaceholder(files: GameFile[]): SourceCheck {
  const source = combined(files);
  const tokens = executableTokens(files);
  const throwing = tokens.some((token, index) => token.kind === "throw" && tokens.slice(index + 1, index + 7).some(item => item.kind === "string" && /not[ _-]?implemented|implement(?:ation)? missing|待实现|代码略|your code here/i.test(item.value)));
  if (throwing) {
    return check(
      "no_placeholder",
      "无占位符",
      "fail",
      "可执行代码显式抛出未实现错误。",
      "补全该函数或删除未实现分支，不能把抛出占位错误的代码当成成品。",
    );
  }
  if (/\bTODO\b|\bFIXME\b|your code here|此处省略|待实现|代码略|省略(?:部分)?代码|实现略/i.test(source)) return check("no_placeholder", "无占位符", "warn", "检测到待办文字；文字和注释不证明玩法缺失，需结合实际行为确认。", "浏览器验收会检查实际执行与输入，待办注释可按需清理。");
  return check("no_placeholder", "无占位符", "pass", "没有发现占位符或未完成标记。");
}

/** A HUD is how the player knows the state changed. Its absence is a smell. */
export function checkHud(files: GameFile[]): SourceCheck {
  const source = codeOnly(files);
  const drawsText = /fillText\s*\(|strokeText\s*\(|textContent\s*=|innerText\s*=|\.\s*innerHTML\s*=/i.test(source);
  const hasMetric = /score|分数|hp|health|lives|生命|time|时间|timer|倒计时|关卡|level/i.test(source);
  if (!drawsText) {
    return check(
      "hud_present",
      "状态显示",
      "warn",
      "没有任何文字输出，玩家看不到分数或状态。",
      "用 fillText 或 DOM 文本显示分数、生命或剩余时间。",
    );
  }
  if (!hasMetric) {
    return check("hud_present", "状态显示", "warn", "有文字输出但没有可识别的分数/生命/时间指标。", "在 HUD 上展示一个会变化的数值，让玩家看到进度。");
  }
  return check("hud_present", "状态显示", "pass", "检测到 HUD 文本与可变化的状态指标。");
}

/** A fixed-size canvas leaves dead margins in the preview window. */
export function checkResponsiveCanvas(files: GameFile[]): SourceCheck {
  const source = combined(files) + files.filter(file => /\.css$/i.test(file.path)).map(file => file.content).join("\n");
  const responsive = /100vw|100vh|innerWidth|innerHeight|clientWidth|clientHeight|offsetWidth|offsetHeight|addEventListener\(\s*["']resize/i.test(source);
  return responsive
    ? check("responsive_canvas", "尺寸自适应", "pass", "画布会跟随窗口尺寸调整。")
    : check(
        "responsive_canvas",
        "尺寸自适应",
        "warn",
        "画布使用固定尺寸，预览窗口里可能留白。",
        "用 window.innerWidth/innerHeight 或 100vw/100vh 让画布填满窗口，并监听 resize。",
      );
}

/**
 * A CDN dependency with no fallback is a white screen in the sandbox, which
 * runs without network access.
 */
export function checkOfflineSafety(files: GameFile[]): SourceCheck {
  const source = combined(files) + files.filter(file => /\.css$/i.test(file.path)).map(file => file.content).join("\n");
  const external = /(?:src|href)\s*=\s*["'](?:https?:|\/\/)|url\(\s*["']?(?:https?:|\/\/)/i.test(source)
    || calls(executableTokens(files), "fetch", /^(?:https?:|\/\/)/i)
    || calls(executableTokens(files), "import", /^(?:https?:|\/\/)/i);
  return external
    ? check("offline_safety", "离线可用", "fail", "发现外部网络资源，离线沙箱无法加载；失败提示本身不能替代游戏。", "将脚本、样式和资产纳入项目文件，移除网络依赖。")
    : check("offline_safety", "离线可用", "pass", "未发现明显网络资源；动态网络调用由浏览器沙箱阻断。");
}

/** A game with no end condition is a toy, not a trap — warn, never block. */
export function checkTerminalState(files: GameFile[]): SourceCheck {
  const source = combined(files);
  const hasEnd = /game\s*over|gameover|失败|结束|胜利|通过|win|lose|dead|die|restart|重新开始|再来一局|gameState\s*=\s*["'](over|end|win|lose)/i.test(source);
  return hasEnd
    ? check("terminal_state", "结束条件", "pass", "检测到胜负或结束状态。")
    : check(
        "terminal_state",
        "结束条件",
        "warn",
        "没有找到失败/胜利/重开逻辑，游戏可能永不结束。",
        "加入胜负判定与重开入口，让玩家知道何时结束、如何再来一局。",
      );
}

/**
 * Ordered so the report reads from "is there a game at all" to "is it a good
 * one". Every gate runs regardless — see `runGates` in `gates.ts` for why the
 * full defect list matters more than an early exit.
 */
export const SOURCE_GATES: ReadonlyArray<(files: GameFile[]) => SourceCheck> = [
  checkRenderTarget,
  checkGameLoop,
  checkInputBinding,
  checkScriptIntegrity,
  checkNoPlaceholder,
  checkHud,
  checkResponsiveCanvas,
  checkOfflineSafety,
  checkTerminalState,
];

export function runSourceGates(files: GameFile[]): SourceGateReport {
  const checks = SOURCE_GATES.map(gate => gate(files));
  const failures = checks.filter(item => item.status === "fail").map(item => `${item.label}：${item.detail}${item.hint ? ` ${item.hint}` : ""}`);
  const warnings = checks.filter(item => item.status === "warn").map(item => `${item.label}：${item.detail}`);
  return { ok: failures.length === 0, checks, failures, warnings };
}
