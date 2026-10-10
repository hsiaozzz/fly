import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { injectRuntimeProbe, probeIsInjected, RUNTIME_PROBE_SCRIPT, PROBE_MESSAGE_SOURCE } from "../../shared/game/runtimeProbe";
import { runSourceGates } from "../../shared/game/sourceGates";
import type { GameFile } from "../../shared/game/types";

/**
 * Integration: the demo pseudo-3D racer (`demo/pseudo3d-racer.html`) pushed
 * through the exact path a generated game takes — source gates, then probe
 * injection. This is the artifact-shaped end of the GameFactory port: if a
 * hand-built, known-good game cannot clear the gates, the gates are wrong,
 * not the game.
 */

const html = readFileSync(new URL("../../demo/pseudo3d-racer.html", import.meta.url), "utf8");
const artifact: GameFile[] = [{ path: "index.html", content: html, language: "html" }];

describe("demo pseudo-3D racer through the full gate pipeline", () => {
  it("is a real, complete game file", () => {
    expect(html.length).toBeGreaterThan(4000);
    expect(html).toContain("<canvas");
  });

  it("passes every static playability gate", () => {
    const report = runSourceGates(artifact);
    const failed = report.checks.filter(check => check.status === "fail");
    expect(failed.map(check => check.name)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("clears the fail-level gates specifically", () => {
    const report = runSourceGates(artifact);
    for (const name of ["render_target", "game_loop", "input_binding", "script_integrity", "no_placeholder"]) {
      expect(report.checks.find(check => check.name === name)?.status).toBe("pass");
    }
  });

  it("survives probe injection with the game code intact", () => {
    const injected = injectRuntimeProbe(html);
    expect(probeIsInjected(injected)).toBe(true);
    // The game's own closing tags must still terminate the document.
    expect(injected.trimEnd().endsWith("</html>")).toBe(true);
    // The game loop must appear before the probe, so the probe observes a
    // running game rather than an empty page.
    expect(injected.indexOf("requestAnimationFrame(loop)")).toBeLessThan(injected.indexOf(PROBE_MESSAGE_SOURCE));
    // No script truncation introduced: open/close counts stay equal.
    const open = (injected.match(/<script[\s>]/gi) ?? []).length;
    const close = (injected.match(/<\/script>/gi) ?? []).length;
    expect(open).toBe(close);
  });

  it("mutant without input listeners is caught by input_binding", () => {
    const mutant = html.replace(/addEventListener\(/g, "addEventIgnored(").replace(/onpointerdown/g, "data-x");
    const report = runSourceGates([{ path: "index.html", content: mutant, language: "html" }]);
    expect(report.checks.find(check => check.name === "input_binding")?.status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("mutant without the animation loop is caught by game_loop", () => {
    const mutant = html.replaceAll("requestAnimationFrame", "requestAnimFrameStub");
    const report = runSourceGates([{ path: "index.html", content: mutant, language: "html" }]);
    expect(report.checks.find(check => check.name === "game_loop")?.status).toBe("fail");
  });

  it("mutant with a TODO comment reports advice without declaring broken gameplay", () => {
    const mutant = html.replace("// ---------- 主循环 ----------", "// TODO: 主循环待补全 ----------");
    const report = runSourceGates([{ path: "index.html", content: mutant, language: "html" }]);
    expect(report.checks.find(check => check.name === "no_placeholder")?.status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("mutant with an executable not-implemented branch is rejected", () => {
    const mutant = html.replace("function update(dt) {", "function update(dt) { throw new Error('Not implemented');");
    expect(mutant).not.toBe(html);
    const report = runSourceGates([{ path: "index.html", content: mutant, language: "html" }]);
    expect(report.checks.find(check => check.name === "no_placeholder")?.status).toBe("fail");
  });

  it("probe script itself remains injectable and self-contained", () => {
    expect(RUNTIME_PROBE_SCRIPT.includes("</script>")).toBe(false);
    expect(RUNTIME_PROBE_SCRIPT.includes("${")).toBe(false);
  });
});
