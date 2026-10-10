import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { injectRuntimeProbe, probeIsInjected, PROBE_MESSAGE_SOURCE, RUNTIME_PROBE_SCRIPT, isProbeMessage } from "../../shared/game/runtimeProbe";

describe("runtimeProbe", () => {
  it("injects the probe before </body>", () => {
    const result = injectRuntimeProbe("<html><body><canvas></canvas></body></html>");
    expect(probeIsInjected(result)).toBe(true);
    expect(result.endsWith("</body></html>")).toBe(true);
    expect(result.indexOf("<canvas>")).toBeLessThan(result.indexOf(PROBE_MESSAGE_SOURCE));
  });

  it("appends the probe when there is no body tag", () => {
    const result = injectRuntimeProbe("<html><canvas></canvas></html>");
    expect(probeIsInjected(result)).toBe(true);
  });

  it("keeps the game source intact after injection", () => {
    const source = "<html><body><canvas id='game'></canvas><script>game();</script></body></html>";
    const result = injectRuntimeProbe(source);
    // Game code is untouched and still executes before the probe.
    expect(result).toContain("game();");
    expect(result).toContain("<canvas id='game'>");
    expect(result.indexOf("game();")).toBeLessThan(result.indexOf(PROBE_MESSAGE_SOURCE));
    // The probe sits before the closing body tag.
    expect(result.endsWith("</body></html>")).toBe(true);
  });

  it("probe script contains no raw </script> that would truncate the host page", () => {
    expect(RUNTIME_PROBE_SCRIPT.includes("</script>")).toBe(false);
  });

  it("probe script observes without injecting inputs or leaking templates", () => {
    // Every placeholder must have been substituted at build time.
    expect(RUNTIME_PROBE_SCRIPT.includes("${")).toBe(false);
    expect(RUNTIME_PROBE_SCRIPT).toContain("parent.postMessage");
    expect(RUNTIME_PROBE_SCRIPT).toContain("getImageData");
    expect(RUNTIME_PROBE_SCRIPT).not.toContain("KeyboardEvent");
    expect(RUNTIME_PROBE_SCRIPT).not.toContain("dispatchEvent");
  });

  it("isProbeMessage accepts only probe-shaped payloads", () => {
    const report = { ok: true, durationMs: 1500, surface: "canvas", errors: [], checks: ["rendered", "animating", "input_responsive", "no_errors", "surface_size"].map(name => ({ name, label: name, detail: "observed", status: "warn" })) };
    const message = { source: PROBE_MESSAGE_SOURCE, runId: "run-1", report };
    expect(isProbeMessage(message, "run-1")).toBe(true);
    expect(isProbeMessage(message, "run-2")).toBe(false);
    expect(isProbeMessage({ ...message, report: null })).toBe(false);
    expect(isProbeMessage({ ...message, report: { ...report, checks: [] } })).toBe(false);
    expect(isProbeMessage({ ...message, report: { ...report, durationMs: NaN } })).toBe(false);
    expect(isProbeMessage({ ...message, report: { ...report, checks: [...report.checks.slice(0, 4), { ...report.checks[4], name: "rendered" }] } })).toBe(false);
    expect(isProbeMessage({ source: "other", report: {} })).toBe(false);
    expect(isProbeMessage(null)).toBe(false);
    expect(isProbeMessage("probe")).toBe(false);
  });

  it("keeps an automatically moving surface from claiming verified input", () => {
    const queue: (() => void)[] = [], listeners = new Map<string, (event: unknown) => void>();
    let frame = 0, payload: any;
    const canvas = { tagName: "CANVAS", width: 320, height: 240 };
    const scope: any = {
      Date, window: { addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn) },
      parent: { postMessage: (message: unknown) => { payload = message; } },
      setTimeout: (fn: () => void) => queue.push(fn),
      document: { querySelector: () => canvas, createElement: () => ({ getContext: () => ({ drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(40 * 40 * 4).fill(frame++ ? 255 : 120) }) }) }) },
    };
    vm.runInNewContext(RUNTIME_PROBE_SCRIPT.replace('"__ARCANE_RUN_ID__"', '"observation-run"'), scope);
    while (queue.length) queue.shift()!();
    expect(payload.runId).toBe("observation-run");
    expect(payload.report.checks.find((check: any) => check.name === "animating").status).toBe("pass");
    expect(payload.report.checks.find((check: any) => check.name === "input_responsive").status).toBe("warn");
    expect(isProbeMessage(payload, "observation-run")).toBe(true);
  });

  it("recognizes a small visible DOM game without needing many elements", () => {
    const queue: (() => void)[] = [];
    let payload: any;
    const button = { tagName: "BUTTON", getBoundingClientRect: () => ({ width: 140, height: 50 }) };
    const scope: any = {
      Date, window: { addEventListener: () => {}, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) },
      parent: { postMessage: (message: unknown) => { payload = message; } },
      setTimeout: (fn: () => void) => queue.push(fn),
      document: { querySelector: () => null, body: { innerText: "点击得分", querySelectorAll: () => [button] } },
    };
    vm.runInNewContext(RUNTIME_PROBE_SCRIPT.replace('"__ARCANE_RUN_ID__"', '"dom-run"'), scope);
    while (queue.length) queue.shift()!();
    expect(payload.report.surface).toBe("dom");
    expect(payload.report.checks.find((check: any) => check.name === "rendered").status).toBe("pass");
    expect(payload.report.checks.find((check: any) => check.name === "input_responsive").status).toBe("warn");
    expect(isProbeMessage(payload, "dom-run")).toBe(true);
  });

  it("keeps a flood of long runtime errors within the accepted report bounds", () => {
    const queue: (() => void)[] = [], listeners = new Map<string, (event: unknown) => void>();
    let payload: any;
    const scope: any = {
      Date, window: { addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn) },
      parent: { postMessage: (message: unknown) => { payload = message; } },
      setTimeout: (fn: () => void) => queue.push(fn),
      document: { querySelector: () => null, body: { innerText: "游戏", querySelectorAll: () => [] } },
    };
    vm.runInNewContext(RUNTIME_PROBE_SCRIPT.replace('"__ARCANE_RUN_ID__"', '"error-run"'), scope);
    for (let i = 0; i < 50; i++) listeners.get("error")!({ message: "x".repeat(10_000) });
    listeners.get("unhandledrejection")!({ reason: "x".repeat(10_000) });
    while (queue.length) queue.shift()!();
    expect(payload.report.ok).toBe(false);
    expect(payload.report.errors).toHaveLength(5);
    expect(payload.report.checks.find((check: any) => check.name === "no_errors").detail).toContain("20 个错误");
    expect(isProbeMessage(payload, "error-run")).toBe(true);
  });

  it("escapes hostile run identifiers before injecting inline JavaScript", () => {
    const result = injectRuntimeProbe("<body></body>", "run</script><script>alert(1)</script>");
    expect(result.match(/<script>/g)).toHaveLength(1);
    expect(result).toContain("\\u003c/script>");
  });
});
