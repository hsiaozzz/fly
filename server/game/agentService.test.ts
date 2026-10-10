import { describe, expect, it } from "vitest";
import { compileGameProject } from "../../shared/game/compiler";
import { gameSpecFromPrompt, validateGameSpec } from "../../shared/game/gamespec";
import { applyGamePatch, patchFromPrompt } from "../../shared/game/patches";
import { validateAndRepairProject } from "./buildAdapter";

describe("GameSpec compiler pipeline", () => {
  it("normalizes a Flappy request into a valid multi-file project", () => {
    const spec = gameSpecFromPrompt("做一个蓝色小鸟躲避管道的 Flappy Bird 游戏");
    expect(spec.game.genre).toBe("flappy");
    expect(validateGameSpec(spec).valid).toBe(true);
    const files = compileGameProject(spec);
    expect(files.length).toBeGreaterThan(12);
    expect(files.find(file => file.path === "package.json")?.content).toContain("phaser");
    expect(files.find(file => file.path === "src/scenes/GameScene.ts")?.content).toContain("spawnPipes");
  });

  it("selects the shooter and runner templates from intent", () => {
    expect(gameSpecFromPrompt("做一个打飞机射击游戏").game.genre).toBe("shooter");
    expect(gameSpecFromPrompt("做一个横版跑酷游戏").game.genre).toBe("runner");
  });

  it("applies a surgical configuration patch instead of regenerating files", () => {
    const spec = gameSpecFromPrompt("Flappy game");
    const files = compileGameProject(spec);
    const patch = patchFromPrompt("把小鸟速度提高 30%，并把管道之间的距离变大", spec.config.playerSpeed, spec.config.obstacleGap);
    const changed = applyGamePatch(files, patch);
    const config = changed.find(file => file.path === "src/config/game.config.ts")?.content ?? "";
    expect(patch.operations).toHaveLength(2);
    expect(config).toContain('"playerSpeed": 416');
    expect(config).toContain('"obstacleGap": 240');
  });

  it("uses no more than three controlled build-repair attempts", () => {
    const repaired = validateAndRepairProject([{ path: "README.md", content: "# incomplete", language: "markdown" }]);
    expect(repaired.report.status).toBe("failed");
    expect(repaired.report.attempts).toBeLessThanOrEqual(3);
    // The repair step can only recreate README.md and game.config.ts, so the
    // third diagnostic is identical to the second. Stopping there is the point:
    // iterating on a defect set that came back unchanged spends an attempt to
    // learn nothing.
    expect(repaired.report.stopReason).toBe("repeating");
    expect(repaired.report.logs.join("\n")).toContain("identical diagnostic");
  });
});
