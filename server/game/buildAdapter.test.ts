import { describe, expect, it } from "vitest";
import { validateAndRepairProject } from "./buildAdapter";
import type { GameFile } from "../../shared/game/types";

const REQUIRED = ["package.json", "tsconfig.json", "vite.config.ts", "src/main.ts", "src/game.ts", "src/config/game.config.ts", "README.md"];

/** A project that satisfies every compiler-contract diagnostic. */
function completeProject(): GameFile[] {
  const content: Record<string, string> = {
    "package.json": JSON.stringify({ scripts: { build: "tsc && vite build" }, dependencies: { phaser: "^3.80.0" } }),
    "tsconfig.json": "{}",
    "vite.config.ts": "export default {};",
    "src/main.ts": "const game = new Phaser.Game({});",
    "src/game.ts": "export const game = {};",
    "src/config/game.config.ts": "export const GAME_CONFIG = {} as const;",
    "README.md": "# game",
  };
  return REQUIRED.map(path => ({ path, content: content[path] ?? "", language: "typescript" as const }));
}

describe("build adapter", () => {
  it("passes a complete project on the first attempt", () => {
    const result = validateAndRepairProject(completeProject());
    expect(result.report.status).toBe("passed");
    expect(result.report.attempts).toBe(1);
    expect(result.report.repairApplied).toBe(false);
    expect(result.report.stopReason).toBe("passed");
  });

  it("repairs what it knows how to recreate", () => {
    const incomplete = completeProject().filter(file => file.path !== "README.md" && file.path !== "src/config/game.config.ts");
    const result = validateAndRepairProject(incomplete);
    expect(result.report.status).toBe("passed");
    expect(result.report.repairApplied).toBe(true);
    expect(result.files.map(file => file.path)).toContain("README.md");
  });

  it("stops as repeating when the repair step cannot address the defect", () => {
    // package.json is outside the repair step's reach, so the diagnostic
    // returns unchanged. The loop notices instead of spending a third attempt.
    const broken = completeProject().filter(file => file.path !== "package.json");
    const result = validateAndRepairProject(broken);
    expect(result.report.status).toBe("failed");
    expect(result.report.stopReason).toBe("repeating");
    expect(result.report.attempts).toBeLessThanOrEqual(3);
  });

  it("never runs more than three attempts", () => {
    const result = validateAndRepairProject([{ path: "README.md", content: "# x", language: "markdown" }]);
    expect(result.report.attempts).toBeLessThanOrEqual(3);
  });
});
