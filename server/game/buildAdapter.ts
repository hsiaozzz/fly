import type { BuildReport, GameFile } from "../../shared/game/types";

type BuildAttempt = { files: GameFile[]; report: BuildReport };

const requiredFiles = ["package.json", "tsconfig.json", "vite.config.ts", "src/main.ts", "src/game.ts", "src/config/game.config.ts", "README.md"];

function diagnostics(files: GameFile[]): string[] {
  const byPath = new Map(files.map(file => [file.path, file]));
  const issues = requiredFiles.filter(path => !byPath.has(path)).map(path => `Missing required generated file: ${path}`);
  const packageJson = byPath.get("package.json")?.content;
  if (packageJson) {
    try {
      const manifest = JSON.parse(packageJson) as { scripts?: Record<string, string>; dependencies?: Record<string, string> };
      if (!manifest.scripts?.build) issues.push("package.json does not declare a build script");
      if (!manifest.dependencies?.phaser) issues.push("package.json does not declare Phaser");
    } catch { issues.push("package.json is not valid JSON"); }
  }
  const main = byPath.get("src/main.ts")?.content ?? "";
  if (main && !main.includes("new Phaser.Game")) issues.push("src/main.ts does not create a Phaser.Game instance");
  return issues;
}

function repairedFiles(files: GameFile[], issues: string[]): GameFile[] {
  const next = files.map(file => ({ ...file }));
  const present = new Set(next.map(file => file.path));
  const create = (path: string, content: string, language: GameFile["language"]) => { if (!present.has(path)) next.push({ path, content, language }); };
  for (const issue of issues) {
    if (issue.includes("README.md")) create("README.md", "# Generated Phaser Game\n\nRun `npm install` then `npm run build`.\n", "markdown");
    if (issue.includes("src/config/game.config.ts")) create("src/config/game.config.ts", "export const GAME_CONFIG = { playerSpeed: 320, gravity: 980, obstacleGap: 180, obstacleInterval: 1650, startingHealth: 1 } as const;\n", "typescript");
  }
  return next;
}

/**
 * This adapter intentionally does not execute a user-controlled npm process in the web server.
 * It performs deterministic compiler-contract validation and can be replaced by a resource-limited
 * external worker that returns real `npm run build` diagnostics through the same BuildReport shape.
 */
export function validateAndRepairProject(sourceFiles: GameFile[]): BuildAttempt {
  let files = sourceFiles;
  const logs = ["[sandbox-adapter] Protected server process; running deterministic compiler-contract validation."];
  // Diagnostics are compared across attempts. `repairedFiles` only knows how to
  // recreate README.md and game.config.ts, so a project missing anything else
  // produces the identical defect list every time — and iterating on a defect
  // set that came back unchanged is the failure this comparison exists to stop.
  let previous: string[] | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const issues = diagnostics(files);
    if (!issues.length) {
      return {
        files,
        report: {
          status: "passed",
          attempts: attempt,
          repairApplied: attempt > 1,
          stopReason: "passed",
          logs: [...logs, "[build] Contract validation passed. Project is eligible for isolated npm build execution."],
        },
      };
    }
    logs.push(`[build] Attempt ${attempt} failed: ${issues.join("; ")}`);
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
    if (previous && same(issues, previous)) {
      logs.push("[debugger] Repair produced an identical diagnostic; the remaining defects are outside the repair step. Stopping instead of repeating it.");
      return { files, report: { status: "failed", attempts: attempt, repairApplied: attempt > 1, stopReason: "repeating", logs } };
    }
    previous = issues;
    if (attempt === 3) {
      return { files, report: { status: "failed", attempts: attempt, repairApplied: true, stopReason: "exhausted", logs: [...logs, "[debugger] Repair limit reached after 3 attempts."] } };
    }
    files = repairedFiles(files, issues);
    logs.push(`[debugger] Applied a controlled repair patch before retry ${attempt + 1}.`);
  }
  return { files, report: { status: "failed", attempts: 3, repairApplied: true, stopReason: "exhausted", logs } };
}
