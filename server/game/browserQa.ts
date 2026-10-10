import { fork, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { artifactDigest, validateArtifact } from "../../shared/game/artifact";
import { bundleGameArtifact } from "../../shared/game/bundle";
import type { GameArtifact } from "../../shared/game/types";
import type { ValidationReport } from "../../shared/game/validation";

export type BrowserQaOptions = { signal?: AbortSignal; seed?: number; viewport?: { width: number; height: number }; timeoutMs?: number };
let active = 0;
export async function validateInBrowser(input: GameArtifact, options: BrowserQaOptions = {}): Promise<ValidationReport> {
  const start = Date.now();
  const hash = await artifactDigest(input);
  const environment: ValidationReport["environment"] = { runner: "playwright", viewport: options.viewport ?? { width: 960, height: 640 }, seed: options.seed ?? 42 };
  const base: ValidationReport = { schemaVersion: 1, artifactHash: hash, status: "unverified", environment, checks: [], errors: [], durationMs: 0, testedAt: new Date().toISOString() };
  try {
    const validation = validateArtifact(input);
    if (!validation.artifact) throw new Error(validation.errors.join("\n"));
    bundleGameArtifact(validation.artifact);
    base.checks.push({ id: "bundle", label: "离线构建与语法", scope: "build", status: "pass", detail: "入口及本地依赖已解析，JavaScript 语法通过。" });
  } catch (error) {
    return { ...base, status: "failed", durationMs: Date.now() - start, checks: [{ id: "bundle", label: "离线构建与语法", scope: "build", status: "fail", detail: error instanceof Error ? error.message : "构建失败。" }] };
  }
  if (active >= 2) return { ...base, checks: [...base.checks, { id: "capacity", label: "浏览器资源", scope: "runtime", status: "unverified", detail: "验证任务已满，请稍后重试。" }] };
  options.signal?.throwIfAborted();
  active++;
  // No application/API credentials are inherited by the process running games.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "DISPLAY", "ARCANE_BROWSER_EXECUTABLE"]) if (process.env[key]) env[key] = process.env[key];
  const production = import.meta.url.endsWith(".js");
  const worker = production ? fileURLToPath(new URL("./browserQaWorker.js", import.meta.url)) : fileURLToPath(new URL("./browserQaWorker.ts", import.meta.url));
  let child: ChildProcess | undefined;
  try {
    child = fork(worker, [], { env, detached: process.platform !== "win32", execArgv: production ? ["--max-old-space-size=256"] : ["--max-old-space-size=256", "--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    return await new Promise<ValidationReport>((resolve, reject) => {
      let settled = false;
      const finish = (report?: ValidationReport, error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(report!);
      };
      const unavailable = (detail: string): ValidationReport => ({ ...base, durationMs: Date.now() - start, checks: [...base.checks, { id: "browser", label: "真实浏览器验证", scope: "runtime", status: "unverified", detail }] });
      const abort = () => finish(undefined, options.signal?.reason ?? new Error("验证已取消。"));
      const timer = setTimeout(() => finish(unavailable("浏览器验证超时，未获得有效结论。")), Math.min(options.timeoutMs ?? 30_000, 45_000));
      options.signal?.addEventListener("abort", abort, { once: true });
      child!.once("error", () => finish(unavailable("浏览器验证进程启动失败。")));
      child!.once("exit", () => finish(unavailable("浏览器验证进程退出，未获得有效结论。")));
      child!.on("message", (message: any) => {
        if (message?.report?.artifactHash === hash) finish({ ...message.report, durationMs: Date.now() - start });
        else if (message?.unavailable) finish(unavailable("浏览器不可用，请配置 ARCANE_BROWSER_EXECUTABLE 或安装受支持的 Chromium。"));
      });
      child!.send({ artifact: input, hash, environment, checks: base.checks });
    });
  } finally {
    // Kill the entire owned tree so hung game scripts cannot retain a browser.
    if (child?.pid && process.platform === "win32") {
      await new Promise<void>(resolve => {
        const killer = spawn("taskkill", ["/PID", String(child!.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        const timer = setTimeout(() => { killer.kill(); child?.kill(); resolve(); }, 2000);
        const finish = () => { clearTimeout(timer); resolve(); };
        killer.once("close", finish); killer.once("error", () => { child?.kill(); finish(); });
      });
    } else if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }
    active--;
  }
}
