import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { within } from "./browser-smoke-helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await access(new URL("../dist/public/index.html", import.meta.url));
// Vite owns an OS-selected free port, so readiness cannot accidentally refer to
// an unrelated preview process left on a fixed port by another test.
const server = await preview({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  logLevel: "warn",
  preview: { host: "127.0.0.1", port: 0, strictPort: true },
});
let activeChild;
const stop = () => {
  if (activeChild?.pid && process.platform !== "win32") {
    try {
      process.kill(-activeChild.pid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
  } else activeChild?.kill();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function killOwnedTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already exited. */
    }
  } else {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    await within(
      new Promise((resolve, reject) => {
        killer.once("error", reject);
        killer.once("exit", resolve);
      }),
      "browser smoke process cleanup",
      5000
    ).catch(() => child.kill());
  }
}

async function run(filename, baseUrl) {
  const child = spawn(process.execPath, [filename], {
    cwd: root,
    detached: process.platform !== "win32",
    stdio: "inherit",
    env: { ...process.env, ARCANE_TEST_BASE_URL: baseUrl },
  });
  activeChild = child;
  try {
    await within(
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) =>
          code === 0
            ? resolve()
            : reject(new Error(`${filename} exited ${signal || code}`))
        );
      }),
      filename,
      120_000
    );
  } finally {
    await killOwnedTree(child);
    activeChild = undefined;
  }
}

try {
  const baseUrl = server.resolvedUrls?.local.find(
    url => new URL(url).hostname === "127.0.0.1"
  )?.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Vite did not expose its own preview URL.");
  const response = await fetch(baseUrl, { signal: AbortSignal.timeout(5000) });
  if (!response.ok)
    throw new Error(`Production frontend preview returned ${response.status}.`);
  await response.arrayBuffer();
  await run("tools/workspace-smoke.mjs", baseUrl);
  await run("tools/project-smoke.mjs", baseUrl);
  await run("tools/workspace-layout-smoke.mjs", baseUrl);
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await server.close();
}
