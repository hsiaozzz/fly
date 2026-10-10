import type { GameFile } from "./types";

/** Passive preview telemetry; it never sends inputs or certifies gameplay. */

export type RuntimeCheckStatus = "pass" | "warn" | "fail";

export type RuntimeCheck = {
  name: string;
  label: string;
  status: RuntimeCheckStatus;
  detail: string;
};

export type RuntimeProbeReport = {
  ok: boolean;
  checks: RuntimeCheck[];
  errors: string[];
  /** Milliseconds the probe spent observing, for the UI. */
  durationMs: number;
  /** "canvas" | "dom" | "none" — what the probe managed to observe. */
  surface: string;
};

export const PROBE_MESSAGE_SOURCE = "arcane-runtime-probe";

export type ProbeMessage = { source: typeof PROBE_MESSAGE_SOURCE; runId: string; report: RuntimeProbeReport };

export function isProbeMessage(value: unknown, expectedRunId?: string): value is ProbeMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.source !== PROBE_MESSAGE_SOURCE || typeof message.runId !== "string" || !message.runId || message.runId.length > 180 || expectedRunId !== undefined && message.runId !== expectedRunId) return false;
  const report = message.report;
  if (!report || typeof report !== "object" || Array.isArray(report)) return false;
  const data = report as Record<string, unknown>;
  if (typeof data.ok !== "boolean" || typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs) || data.durationMs < 0 || data.durationMs > 600_000 || !["canvas", "dom", "none", "unmeasurable"].includes(String(data.surface))) return false;
  if (!Array.isArray(data.errors) || data.errors.length > 20 || data.errors.some(error => typeof error !== "string" || error.length > 4000)) return false;
  if (!Array.isArray(data.checks) || data.checks.length !== 5) return false;
  const required = new Set(["rendered", "animating", "input_responsive", "no_errors", "surface_size"]);
  for (const item of data.checks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const check = item as Record<string, unknown>;
    if (typeof check.name !== "string" || !required.delete(check.name) || !["pass", "warn", "fail"].includes(String(check.status)) || typeof check.label !== "string" || typeof check.detail !== "string" || check.label.length > 100 || check.detail.length > 4000) return false;
  }
  return data.ok === data.checks.every(item => item.status !== "fail");
}

/** Sample grid. 40x40 is enough to detect motion and cheap to hash. */
const SAMPLE_GRID = 40;

/** Motion below this is indistinguishable from a still frame. */
const MOTION_THRESHOLD = 0.01;

/**
 * The probe source. Injected immediately before `</body>` so it runs after the
 * game's own scripts have had a chance to create the canvas.
 *
 * Written as plain ES5-flavoured browser JS on purpose: it is inlined into an
 * arbitrary generated page and must not depend on the host bundler.
 */
export const RUNTIME_PROBE_SCRIPT = `
(function () {
  var GRID = ${SAMPLE_GRID};
  var MOTION = ${MOTION_THRESHOLD};
  var errors = [];
  var started = Date.now();

  window.addEventListener("error", function (event) {
    if (errors.length < 20) errors.push(String((event && event.message) || "unknown error").slice(0, 3000));
  });
  window.addEventListener("unhandledrejection", function (event) {
    if (errors.length < 20) errors.push("unhandled rejection: " + String(event && event.reason).slice(0, 3000));
  });

  function pickSurface() {
    var canvas = document.querySelector("canvas");
    if (canvas) return canvas;
    var svg = document.querySelector("svg");
    if (svg) return svg;
    return null;
  }

  function sample() {
    var canvas = pickSurface();
    if (canvas && canvas.tagName === "CANVAS") {
      try {
        var w = canvas.width || 0;
        var h = canvas.height || 0;
        if (!w || !h) return { kind: "canvas", size: [w, h], fill: 0, cells: null };
        var off = document.createElement("canvas");
        off.width = GRID;
        off.height = GRID;
        var ctx = off.getContext("2d");
        ctx.drawImage(canvas, 0, 0, GRID, GRID);
        var data = ctx.getImageData(0, 0, GRID, GRID).data;
        var cells = new Array(GRID * GRID);
        var filled = 0;
        for (var i = 0; i < GRID * GRID; i++) {
          var p = i * 4;
          var alpha = data[p + 3];
          var lum = (data[p] + data[p + 1] + data[p + 2]) / 3;
          cells[i] = alpha === 0 ? 0 : Math.round(lum / 16);
          if (alpha !== 0 && lum > 8) filled++;
        }
        return { kind: "canvas", size: [w, h], fill: filled / (GRID * GRID), cells: cells };
      } catch (error) {
        // Tainted canvas (cross-origin image) or a WebGL surface with no 2d
        // readback. Not a game defect: report as unmeasurable.
        return { kind: "unmeasurable", size: [canvas.width || 0, canvas.height || 0], fill: -1, cells: null };
      }
    }
    if (canvas) return { kind: "unmeasurable", size: [0, 0], fill: -1, cells: null };
    var body = document.body;
    if (!body) return { kind: "none", size: [0, 0], fill: 0, cells: null };
    var text = (body.innerText || "").replace(/\\s+/g, " ").slice(0, 2000);
    var elements = body.querySelectorAll("*"), visible = 0;
    for (var n = 0; n < elements.length; n++) {
      var element = elements[n];
      if (/^(SCRIPT|STYLE|LINK|META)$/.test(element.tagName || "")) continue;
      var rect = element.getBoundingClientRect ? element.getBoundingClientRect() : null;
      var style = window.getComputedStyle ? window.getComputedStyle(element) : null;
      if (rect && rect.width > 0 && rect.height > 0 && (!style || style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0")) visible++;
    }
    return { kind: "dom", size: [visible, 0], fill: text.trim() || visible ? Math.max(0.05, Math.min(1, visible / 200)) : 0, cells: null, text: text };
  }

  function diff(a, b) {
    if (!a || !b) return 0;
    if (a.cells && b.cells) {
      var changed = 0;
      for (var i = 0; i < a.cells.length; i++) if (a.cells[i] !== b.cells[i]) changed++;
      return changed / a.cells.length;
    }
    if (a.kind === "dom" && b.kind === "dom") return a.text === b.text ? 0 : 1;
    return 0;
  }

  var trustedInputs = 0;
  ["pointerdown", "keydown", "touchstart"].forEach(function (type) {
    window.addEventListener(type, function (event) { if (event && event.isTrusted) trustedInputs++; }, true);
  });

  function report(checks, surface) {
    var payload = {
      source: "${PROBE_MESSAGE_SOURCE}",
      runId: "__ARCANE_RUN_ID__",
      report: {
        ok: checks.every(function (item) { return item.status !== "fail"; }),
        checks: checks,
        errors: errors.slice(0, 5),
        durationMs: Date.now() - started,
        surface: surface
      }
    };
    window.__ARCANE_PROBE__ = payload.report;
    try {
      parent.postMessage(payload, "*");
    } catch (error) {}
  }

  setTimeout(function () {
    var first = sample();
    var surface = first.kind === "unmeasurable" ? "unmeasurable" : first.kind;

    setTimeout(function () {
      var second = sample();

      setTimeout(function () {

        setTimeout(function () {
          var third = sample();
          var idleMotion = diff(first, second);
          var inputMotion = diff(second, third);
          var checks = [];

          checks.push({
            name: "rendered",
            label: "画面已渲染",
            status: first.fill > 0 ? "pass" : first.fill < 0 ? "warn" : "fail",
            detail: first.fill > 0
              ? "预览画面有内容（覆盖 " + Math.round(first.fill * 100) + "% 采样点）。"
              : first.fill < 0
                ? "无法读取画面像素（跨域画布或非 2D 渲染），跳过此项。"
                : "预览画面是空白的，没有任何可见内容。"
          });

          checks.push({
            name: "animating",
            label: "画面在变化",
            status: surface === "unmeasurable" ? "warn" : idleMotion > MOTION ? "pass" : "warn",
            detail: surface === "unmeasurable"
              ? "无法采样，跳过运动检测。"
              : idleMotion > MOTION
                ? "静止观察期间画面自行变化了 " + Math.round(idleMotion * 100) + "%。"
                : "静止观察期间画面没有变化（可能停在开始菜单）。"
          });

          checks.push({
            name: "input_responsive",
            label: "输入待验收",
            status: "warn",
            detail: trustedInputs
              ? "观察到 " + trustedInputs + " 次真实用户输入；被动画影响的画面变化不足以证明输入有效，须完成浏览器验收。"
              : "此探针只观察画面，没有注入按键或点击；输入响应尚未验证。"
          });

          checks.push({
            name: "no_errors",
            label: "运行无报错",
            status: errors.length ? "fail" : "pass",
            detail: errors.length ? "运行期间捕获到 " + errors.length + " 个错误：" + errors[0] : "运行期间没有捕获到 JS 错误。"
          });

          var surfaceSize = first.size || [0, 0];
          checks.push({
            name: "surface_size",
            label: "画布尺寸",
            status: surfaceSize[0] >= 100 && surfaceSize[1] >= 100 ? "pass" : "warn",
            detail: surface === "canvas"
              ? "画布尺寸 " + surfaceSize[0] + " x " + surfaceSize[1] + "。"
              : "未检测到 canvas（surface=" + surface + "），以 DOM 内容作为渲染依据。"
          });

          report(checks, surface);
        }, 700);
      }, 120);
    }, 700);
  }, 900);
})();
`;

/**
 * Inline the probe into generated HTML, just before `</body>` so the game's
 * own scripts have already run.
 *
 * A page with no `</body>` still gets the probe: appending it is safe because
 * inline scripts execute in document order, and everything the probe needs is
 * already parsed.
 */
export function injectRuntimeProbe(html: string, runId = "legacy-preview"): string {
  const encodedRunId = JSON.stringify(runId).replace(/</g, "\\u003c");
  const script = RUNTIME_PROBE_SCRIPT.replace('"__ARCANE_RUN_ID__"', encodedRunId);
  const wrapped = `<script>${script}</script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${wrapped}</body>`);
  return `${html}${wrapped}`;
}

/**
 * Server-side preview files are not probed — the probe only makes sense inside
 * a live browser. Exported so callers can assert the injection is wired up
 * without launching one.
 */
export function probeIsInjected(html: string): boolean {
  return html.includes(PROBE_MESSAGE_SOURCE);
}

export function indexHtmlOf(files: GameFile[]): string | null {
  return files.find(file => file.path === "index.html")?.content ?? null;
}
