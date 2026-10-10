import type { GameFile, GamePatch, PatchOperation } from "./types";

function languageForPath(path: string): GameFile["language"] {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".html")) return "html";
  return "text";
}

function applyOperation(files: GameFile[], operation: PatchOperation): GameFile[] {
  const next = files.map(file => ({ ...file }));
  const index = next.findIndex(file => file.path === operation.file);
  if (operation.op === "create") {
    if (index >= 0) throw new Error(`Cannot create existing file: ${operation.file}`);
    return [...next, { path: operation.file, content: operation.content ?? "", language: operation.language ?? languageForPath(operation.file) }];
  }
  if (operation.op === "delete") {
    if (index < 0) throw new Error(`Cannot delete missing file: ${operation.file}`);
    next.splice(index, 1);
    return next;
  }
  if (operation.op === "rename") {
    const to = operation.to ?? "";
    if (index < 0 || next.some(file => file.path === to)) throw new Error(`Cannot rename file: ${operation.file}`);
    next[index] = { ...next[index], path: to, language: languageForPath(to) };
    return next;
  }
  if (index < 0) throw new Error(`Cannot modify missing file: ${operation.file}`);
  if (typeof operation.content === "string") {
    next[index].content = operation.content;
    return next;
  }
  if (!operation.target || operation.value === undefined) throw new Error(`Modify operation requires content or target/value for ${operation.file}`);
  const escapedTarget = operation.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(`(\\"?${escapedTarget}\\"?\\s*:\\s*)[^,\\n]+`);
  if (!expression.test(next[index].content)) throw new Error(`Target ${operation.target} not found in ${operation.file}`);
  const value = typeof operation.value === "string" ? JSON.stringify(operation.value) : String(operation.value);
  next[index].content = next[index].content.replace(expression, `$1${value}`);
  return next;
}

export function applyGamePatch(files: GameFile[], patch: GamePatch): GameFile[] {
  if (patch.type !== "game_patch") throw new Error("Unsupported patch type");
  return patch.operations.reduce(applyOperation, files);
}

export function patchFromPrompt(prompt: string, currentSpeed: number, currentGap: number): GamePatch {
  const lower = prompt.toLowerCase();
  const operations: PatchOperation[] = [];
  if (/速度|speed/.test(lower)) {
    const nextSpeed = /30%/.test(lower) ? Math.round(currentSpeed * 1.3) : Math.round(currentSpeed * 1.15);
    operations.push({ op: "modify", file: "src/config/game.config.ts", target: "playerSpeed", value: nextSpeed });
  }
  if (/管道.*距离|间距|gap/.test(lower)) {
    operations.push({ op: "modify", file: "src/config/game.config.ts", target: "obstacleGap", value: Math.min(600, currentGap + 60) });
  }
  if (!operations.length) {
    operations.push({ op: "modify", file: "README.md", content: "# Game change request\n\nThis version records the latest requested adjustment.\n" });
  }
  return { type: "game_patch", rationale: "The patch agent selected only the configuration files affected by the request.", operations };
}
