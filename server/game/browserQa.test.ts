import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { fork } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserQaEnvironment, browserQaFailureReason, validateInBrowser } from "./browserQa";
import type { GameArtifact } from "../../shared/game/types";

vi.mock("node:child_process", () => ({ fork: vi.fn(), spawn: vi.fn() }));

const artifact: GameArtifact = {
  title: "QA diagnostic isolation",
  description: "",
  controls: [],
  files: [{ path: "index.html", language: "html", content: "<button>Game</button>" }],
};

function worker(run: (child: EventEmitter & { stderr: PassThrough }) => void) {
  const child = Object.assign(new EventEmitter(), {
    stderr: new PassThrough(),
    send: vi.fn(() => queueMicrotask(() => run(child))),
  });
  vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>);
}

afterEach(() => vi.restoreAllMocks());

describe("browser QA process isolation and bounded diagnostics", () => {
  it("forwards Linux/Windows OS directories without application credentials or Node injection", () => {
    const source = {
      PATH: "/bin", HOME: "/home/runner", USERPROFILE: "C:\\Users\\runner",
      XDG_CACHE_HOME: "/cache", XDG_CONFIG_HOME: "/config", XDG_DATA_HOME: "/data", XDG_RUNTIME_DIR: "/run/user/1000",
      ARCANE_BROWSER_EXECUTABLE: "/browser/chrome",
      DATABASE_URL: "secret-db", OPENAI_API_KEY: "secret-model", JWT_SECRET: "secret-jwt",
      AWS_SECRET_ACCESS_KEY: "secret-storage", NODE_OPTIONS: "--require /secret/inject.js", NPM_TOKEN: "secret-npm",
    };
    const result = browserQaEnvironment(source);
    expect(result).toEqual({
      PATH: source.PATH, HOME: source.HOME, USERPROFILE: source.USERPROFILE,
      XDG_CACHE_HOME: source.XDG_CACHE_HOME, XDG_CONFIG_HOME: source.XDG_CONFIG_HOME,
      XDG_DATA_HOME: source.XDG_DATA_HOME, XDG_RUNTIME_DIR: source.XDG_RUNTIME_DIR,
      ARCANE_BROWSER_EXECUTABLE: source.ARCANE_BROWSER_EXECUTABLE,
    });
    expect(result).not.toBe(source);
  });

  it("accepts only finite failure categories from worker IPC", () => {
    expect(browserQaFailureReason("crashpad-configuration")).toBe("crashpad-configuration");
    for (const value of ["secret-launch-error", { reason: "sandbox-unavailable" }, null, 1])
      expect(browserQaFailureReason(value)).toBe("worker-failed");
  });

  it("keeps arbitrary IPC reasons out of both logs and the HTTP report", async () => {
    const secret = "BUSINESS_SECRET_AND_GAME_SOURCE";
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    worker(child => child.emit("message", { unavailable: true, reason: secret }));
    const report = await validateInBrowser(artifact);
    expect(report.status).toBe("unverified");
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(JSON.stringify({ event: "browser_qa_unavailable", reason: "worker-failed" }));
  });

  it("classifies worker crashes without emitting raw stderr", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    worker(child => {
      child.stderr.write("BUSINESS_SECRET: ERR_MODULE_NOT_FOUND /private/project/path");
      child.emit("exit", 1);
    });
    const report = await validateInBrowser(artifact);
    expect(JSON.stringify(report)).not.toContain("BUSINESS_SECRET");
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(JSON.stringify({ event: "browser_qa_unavailable", reason: "worker-runtime-dependency" }));
  });

  it("retains only the bounded stderr tail and logs only once after settlement", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    worker(child => {
      child.stderr.write("ERR_MODULE_NOT_FOUND" + "x".repeat(20_000));
      child.emit("exit", 1);
      child.emit("message", { unavailable: true, reason: "executable-missing" });
    });
    await validateInBrowser(artifact);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(JSON.stringify({ event: "browser_qa_unavailable", reason: "worker-exit" }));
  });
});

describe.skipIf(process.platform !== "linux")("POSIX browser group cleanup", () => {
  const browserScript = `
    const {spawn}=require('node:child_process');
    const renderer=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    process.send({rendererPid:renderer.pid});
    setInterval(()=>{},1000);
  `;
  const workerScript = `
    const {spawn}=require('node:child_process');
    process.once('message',()=>{
      const browser=spawn(process.execPath,['-e',${JSON.stringify(browserScript)}],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
      browser.once('message',message=>process.send({launchedPid:browser.pid,rendererPid:message.rendererPid}));
    });
    // Deliberately ignore shutdown: exercise the bounded force-kill fallback.
    setInterval(()=>{},1000);
  `;
  function alive(pid: number) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    } catch { return false; }
  }
  it.each(["timeout", "abort"])("removes independently detached browser/renderer after %s even before PID registration", async mode => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let child: ReturnType<typeof actual.spawn> | undefined;
    let launchedPid = 0;
    let rendererPid = 0;
    let ready!: () => void;
    const readiness = new Promise<void>(resolve => ready = resolve);
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(fork).mockImplementation(() => {
      child = actual.spawn(process.execPath, ["-e", workerScript], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      child.on("message", (message: any) => {
        // This launch-window fixture intentionally does not register browserPid.
        launchedPid = message.launchedPid;
        rendererPid = message.rendererPid;
        ready();
      });
      return child;
    });
    const controller = new AbortController();
    // Allow process startup under the full CI suite's concurrent worker load.
    const pending = validateInBrowser(artifact, { timeoutMs: 8000, signal: controller.signal }).then(report => ({ report }), error => ({ error }));
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([readiness, new Promise((_, reject) => readinessTimer = setTimeout(() => reject(new Error("fixture readiness timeout")), 6000))]);
      clearTimeout(readinessTimer);
      expect(launchedPid).toBeGreaterThan(1);
      expect(rendererPid).toBeGreaterThan(1);
      expect(alive(launchedPid)).toBe(true);
      if (mode === "abort") controller.abort(new Error("cleanup abort"));
      const result = await pending;
      if ("error" in result) expect(String(result.error)).toContain("cleanup abort");
      else expect(result.report.status).toBe("unverified");
      for (let i = 0; i < 25 && (alive(launchedPid) || alive(rendererPid)); i++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(alive(launchedPid)).toBe(false);
      expect(alive(rendererPid)).toBe(false);
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
      if (mode === "timeout") expect(logger).toHaveBeenCalledWith(JSON.stringify({ event: "browser_qa_unavailable", reason: "validation-timeout" }));
    } finally {
      clearTimeout(readinessTimer);
      controller.abort();
      await pending;
      for (const pid of [launchedPid, child?.pid]) if (pid) try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  }, 15000);
});
