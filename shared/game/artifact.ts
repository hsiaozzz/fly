import type { GameArtifact, GameFile, GameFileLanguage } from "./types";

export const ARTIFACT_LIMITS = { files: 40, fileBytes: 400_000, totalBytes: 3_000_000 } as const;
const encoder = new TextEncoder();
const languages: GameFileLanguage[] = ["html", "javascript", "css", "typescript", "json", "markdown", "text"];

export function languageForPath(path: string): GameFileLanguage {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({ html: "html", htm: "html", js: "javascript", mjs: "javascript", css: "css", ts: "typescript", tsx: "typescript", json: "json", md: "markdown" } as Record<string, GameFileLanguage>)[ext ?? ""] ?? "text";
}

export function safeGamePath(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || !value || value.length > 180 || !/^[a-zA-Z0-9_ ./-]+$/.test(value)) throw new Error("文件路径不合法。");
  const parts = value.split("/");
  if (parts[0].toLowerCase() === "__arcane__") throw new Error("__arcane__ 是导出产物保留目录。");
  if (parts.some(part => !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`不安全的文件路径：${value}`);
  return value;
}

export function normalizeGameFiles(input: unknown): GameFile[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > ARTIFACT_LIMITS.files) throw new Error(`文件数量必须为 1–${ARTIFACT_LIMITS.files}。`);
  let total = 0;
  const seen = new Set<string>();
  const files = input.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("文件记录不合法。");
    const file = item as Record<string, unknown>;
    const path = safeGamePath(file.path);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new Error(`重复文件路径：${path}`);
    seen.add(key);
    if (typeof file.content !== "string") throw new Error(`文件内容必须为字符串：${path}`);
    const bytes = encoder.encode(file.content).length;
    total += bytes;
    if (bytes > ARTIFACT_LIMITS.fileBytes || total > ARTIFACT_LIMITS.totalBytes) throw new Error(`文件大小超出限制：${path}`);
    const language = languages.includes(file.language as GameFileLanguage) ? file.language as GameFileLanguage : languageForPath(path);
    return { path, content: file.content, language };
  });
  if (!files.some(file => file.path === "index.html" && file.content.trim())) throw new Error("缺少有效的 index.html 入口。");
  return files;
}

export function validateArtifact(input: unknown): { valid: boolean; errors: string[]; artifact: GameArtifact | null } {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("游戏产物必须是对象。");
    const record = input as Record<string, unknown>;
    if (typeof record.title !== "string" || !record.title.trim() || record.title.length > 120) throw new Error("游戏标题不合法。");
    if (typeof record.description !== "string" || record.description.length > 2000) throw new Error("游戏描述不合法。");
    if (!Array.isArray(record.controls) || record.controls.length > 16 || record.controls.some(control => typeof control !== "string" || control.length > 250)) throw new Error("操作说明不合法。");
    const artifact: GameArtifact = { title: record.title.trim(), description: record.description, controls: record.controls as string[], files: normalizeGameFiles(record.files) };
    return { valid: true, errors: [], artifact };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : "游戏产物不合法。"], artifact: null };
  }
}

/** File order is presentation only. Metadata and every source byte are hashed. */
export function snapshotText(artifact: GameArtifact): string {
  return JSON.stringify({ title: artifact.title, description: artifact.description, controls: artifact.controls, files: [...artifact.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(({ path, content, language }) => ({ path, content, language })) });
}

export async function artifactDigest(artifact: GameArtifact): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(snapshotText(artifact)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
