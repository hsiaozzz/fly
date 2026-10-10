import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
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
