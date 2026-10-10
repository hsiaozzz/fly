import { fork, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { artifactDigest, validateArtifact } from "../../shared/game/artifact";
import { bundleGameArtifact } from "../../shared/game/bundle";
import type { GameArtifact } from "../../shared/game/types";
import type { ValidationReport } from "../../shared/game/validation";

export type BrowserQaOptions = { signal?: AbortSignal; seed?: number; viewport?: { width: number; height: number }; timeoutMs?: number };
const failureReasons = ["executable-missing", "executable-permission", "sandbox-unavailable", "crashpad-configuration", "system-library-missing", "launch-timeout", "launch-failed", "worker-memory", "worker-runtime-dependency", "worker-start-failed", "worker-exit", "validation-timeout", "runtime-step-timeout", "browser-runtime-closed", "worker-failed"] as const;
type FailureReason = typeof failureReasons[number];
export function browserQaFailureReason(value: unknown): FailureReason {
  return typeof value === "string" && failureReasons.includes(value as FailureReason) ? value as FailureReason : "worker-failed";
}
export function browserQaEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "ARCANE_BROWSER_EXECUTABLE"]) if (source[key]) env[key] = source[key];
  return env;
}
function startupBrowserGroups(workerPid: number): number[] {
  // Cover cancellation during launch, before BrowserServer.process() is ready.
  // Only accept direct children of our live worker which lead their own group.
  if (process.platform !== "linux") return [];
  try {
    const children = readFileSync(`/proc/${workerPid}/task/${workerPid}/children`, "utf8").trim().split(/\s+/).slice(0, 64);
    return children.flatMap(value => {
      const pid = Number(value);
      if (!Number.isSafeInteger(pid) || pid <= 1) return [];
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        return Number(fields[1]) === workerPid && Number(fields[2]) === pid ? [pid] : [];
      } catch { return []; }
    });
  } catch { return []; }
}
export async function shutdownBrowserQaWorker(child: ChildProcess, browserPids: Set<number>, graceMs = 1000): Promise<void> {
  if (!child.pid) return;
  for (const pid of startupBrowserGroups(child.pid)) browserPids.add(pid);
  const exited = () => child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined;
  if (!exited()) {
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); resolve(); };
      const timer = setTimeout(finish, graceMs);
      child.once("exit", finish);
      if (child.connected) {
        try { child.send({ shutdown: true }, () => {}); } catch { finish(); }
      } else finish();
    });
  }
  for (const pid of startupBrowserGroups(child.pid)) browserPids.add(pid);
  // Playwright launches Chromium detached: killing only the worker's PGID
  // cannot cover that browser. Retain its separately registered group here.
  const ownedPids = [...browserPids, child.pid];
  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot || process.env.WINDIR || "C:\\Windows"}\\System32\\taskkill.exe`;
    await Promise.all(ownedPids.map(pid => new Promise<void>(resolve => {
      const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => { killer.kill(); if (pid === child.pid) child.kill(); finish(); }, 2000);
      const finish = () => { clearTimeout(timer); resolve(); };
      killer.once("close", finish); killer.once("error", () => { if (pid === child.pid) child.kill(); finish(); });
    })));
  } else {
    for (const pid of ownedPids) {
      try { process.kill(-pid, "SIGKILL"); } catch { if (pid === child.pid && !exited()) child.kill("SIGKILL"); }
    }
    if (!exited()) await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); resolve(); };
      const timer = setTimeout(finish, 250);
      child.once("exit", finish);
      if (exited()) finish();
    });
  }
}
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
  const env = browserQaEnvironment(process.env);
  const production = import.meta.url.endsWith(".js");
  const worker = production ? fileURLToPath(new URL("./browserQaWorker.js", import.meta.url)) : fileURLToPath(new URL("./browserQaWorker.ts", import.meta.url));
  let child: ChildProcess | undefined;
  const browserPids = new Set<number>();
  try {
    child = fork(worker, [], { env, detached: process.platform !== "win32", execArgv: production ? ["--max-old-space-size=256"] : ["--max-old-space-size=256", "--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    // Keep a bounded tail only for fixed-category crash diagnosis. Never log it.
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-16_384);
    });
    return await new Promise<ValidationReport>((resolve, reject) => {
      let settled = false;
      const finish = (report?: ValidationReport, error?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(report!);
      };
      const unavailable = (detail: string): ValidationReport => ({ ...base, durationMs: Date.now() - start, checks: [...base.checks, { id: "browser", label: "真实浏览器验证", scope: "runtime", status: "unverified", detail }] });
      const finishUnavailable = (reason: unknown, detail: string) => {
        if (settled) return;
        console.error(JSON.stringify({ event: "browser_qa_unavailable", reason: browserQaFailureReason(reason) }));
        finish(unavailable(detail));
      };
      const abort = () => finish(undefined, options.signal?.reason ?? new Error("验证已取消。"));
      const timer = setTimeout(() => finishUnavailable("validation-timeout", "浏览器验证超时，未获得有效结论。"), Math.min(options.timeoutMs ?? 30_000, 45_000));
      options.signal?.addEventListener("abort", abort, { once: true });
      child!.once("error", () => finishUnavailable("worker-start-failed", "浏览器验证进程启动失败。"));
      child!.once("exit", () => {
        const reason = /heap out of memory/i.test(stderrTail) ? "worker-memory" : /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/i.test(stderrTail) ? "worker-runtime-dependency" : "worker-exit";
        finishUnavailable(reason, "浏览器验证进程退出，未获得有效结论。");
      });
      child!.on("message", (message: any) => {
        if (Number.isSafeInteger(message?.browserPid) && message.browserPid > 1 && message.browserPid !== process.pid && message.browserPid !== child!.pid && browserPids.size < 4) browserPids.add(message.browserPid);
        else if (message?.report?.artifactHash === hash) finish({ ...message.report, durationMs: Date.now() - start });
        else if (message?.unavailable) finishUnavailable(message.reason, "浏览器不可用，请配置 ARCANE_BROWSER_EXECUTABLE 或安装受支持的 Chromium。");
      });
      child!.send({ artifact: input, hash, environment, checks: base.checks });
    });
  } finally {
    try { if (child) await shutdownBrowserQaWorker(child, browserPids); }
    finally { active--; }
  }
}
