import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const project = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.some(argument => argument !== "--skip-browser")) {
  throw new Error("Usage: node tools/verify-production.mjs [--skip-browser]");
}
const skipBrowser = args.includes("--skip-browser");
const cancellation = new AbortController();
const children = new Set();
const cancelled = signal => () => cancellation.abort(new Error(`Production verification interrupted by ${signal}.`));
const interrupt = cancelled("SIGINT"), terminate = cancelled("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);

// Preserve only operating-system paths, locale and browser configuration. In
// particular, omit NODE_OPTIONS, npm auth variables and application credentials.
const environment = {};
for (const key of [
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "ComSpec",
  "TEMP", "TMP", "TMPDIR", "LOCALAPPDATA", "APPDATA", "PNPM_HOME",
  "XDG_CACHE_HOME", "XDG_DATA_HOME", "LANG", "LC_ALL", "TZ", "DISPLAY",
  "ARCANE_BROWSER_EXECUTABLE", "PLAYWRIGHT_BROWSERS_PATH",
]) {
  if (process.env[key]) environment[key] = process.env[key];
}
environment.NODE_ENV = "test";
environment.CI = "true";

async function installedStoreDirectory() {
  let metadata;
  try { metadata = await readFile(path.join(project, "node_modules", ".modules.yaml"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  // Consume only pnpm's non-sensitive storeDir scalar. Do not load a personal
  // npmrc merely to discover a cache location, or evaluate arbitrary YAML tags.
  const matches = [...metadata.matchAll(/^storeDir:[ \t]*(.*)$/gm)];
  if (!matches.length) return undefined;
  assert.equal(matches.length, 1, "Installed pnpm metadata must have only one storeDir.");
  const raw = matches[0][1].trim();
  if (!raw) return undefined;
  let directory;
  if (raw.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(raw);
    assert.ok(quoted, "Invalid single-quoted pnpm storeDir.");
    directory = quoted[1].replace(/''/g, "'");
  } else if (raw.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(raw);
    assert.ok(quoted, "Invalid double-quoted pnpm storeDir.");
    // pnpm emits JSON-compatible escapes for quoted filesystem paths.
    directory = JSON.parse(quoted[1]);
  } else {
    directory = raw.replace(/\s+#.*$/, "").trim();
  }
  assert.ok(typeof directory === "string" && !/[\u0000-\u001f\u007f]/.test(directory) && path.isAbsolute(directory), "Installed pnpm storeDir must be an absolute filesystem path.");
  return directory;
}

async function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise(resolve => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        env: environment, stdio: "ignore", windowsHide: true,
      });
      let finished = false;
      const finish = () => { if (!finished) { finished = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { killer.kill(); child.kill(); finish(); }, 2000);
      killer.once("error", () => { child.kill(); finish(); });
      killer.once("close", finish);
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }
}

async function run(label, command, commandArgs, cwd, timeoutMs, streamOutput = false) {
  cancellation.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd, env: environment, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    children.add(child);
    let tail = "", settled = false, stopping = false;
    const capture = data => { tail = (tail + data.toString()).slice(-16_000); };
    child.stdout.on("data", data => { capture(data); if (streamOutput) process.stdout.write(data); });
    child.stderr.on("data", data => { capture(data); if (streamOutput) process.stderr.write(data); });
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      cancellation.signal.removeEventListener("abort", abort);
      if (error) reject(new Error(`${label}: ${error.message}${tail ? `\n${tail.trim()}` : ""}`, { cause: error }));
      else resolve();
    };
    const stop = async error => {
      if (stopping || settled) return;
      stopping = true;
      await stopTree(child).catch(() => {});
      finish(error);
    };
    const abort = () => { void stop(cancellation.signal.reason); };
    const timer = setTimeout(() => { void stop(new Error(`Timed out after ${timeoutMs / 1000} seconds.`)); }, timeoutMs);
    cancellation.signal.addEventListener("abort", abort, { once: true });
    child.once("error", error => { children.delete(child); finish(error); });
    child.once("close", (code, signal) => {
      children.delete(child);
      if (!stopping) finish(code === 0 ? undefined : new Error(`Child exited with ${signal ? `signal ${signal}` : `code ${code}`}.`));
    });
    if (cancellation.signal.aborted) abort();
  });
}

let temporary;
try {
  await access(path.join(project, "dist", "index.js"), constants.R_OK);
  if (!skipBrowser) await access(path.join(project, "dist", "qa-smoke.js"), constants.R_OK);
  // Prefer the pnpm CLI that launched this script. The local fallback also
  // permits direct Node invocation without downloading a package manager.
  const callerCli = process.env.npm_execpath;
  const pnpmCli = callerCli && /pnpm/i.test(path.basename(callerCli))
    ? path.resolve(callerCli) : path.join(project, "node_modules", "pnpm", "bin", "pnpm.cjs");
  await access(pnpmCli, constants.R_OK);
  const storeDirectory = await installedStoreDirectory();
  temporary = await mkdtemp(path.join(tmpdir(), "arcane-production-"));
  for (const name of ["dist", "package.json", "pnpm-lock.yaml", "patches", ".npmrc"]) {
    await cp(path.join(project, name), path.join(temporary, name), {
      recursive: true,
      filter: source => {
        const name = path.basename(source);
        return name !== ".env" && !name.startsWith(".env.");
      },
    });
  }
  // Prevent pnpm from loading a personal ~/.npmrc. The project configuration
  // contains registry/timeouts only; no .env file is copied or loaded.
  environment.NPM_CONFIG_USERCONFIG = path.join(temporary, ".npmrc");
  console.log("[production] Installing production dependencies from the offline store.");
  await run("Offline production install", process.execPath, [
    pnpmCli, "install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--offline",
    "--config.manage-package-manager-versions=false", "--reporter=append-only",
    ...(storeDirectory ? ["--store-dir", storeDirectory] : []),
  ], temporary, 180_000);
  const installed = await readdir(path.join(temporary, "node_modules", ".pnpm"));
  const requireFromTemporary = createRequire(path.join(temporary, "package.json"));
  for (const dependency of ["vite", "tsx", "typescript"]) {
    // tRPC has a TypeScript peer which may remain inside pnpm's store. It must
    // not supply a top-level development entry to the compiled application.
    if (dependency !== "typescript") assert.equal(installed.some(name => name.startsWith(`${dependency}@`)), false, `${dependency} must not be installed in the production package store.`);
    const present = await access(path.join(temporary, "node_modules", dependency)).then(() => true, () => false);
    assert.equal(present, false, `${dependency} must not be a production dependency.`);
    assert.throws(() => requireFromTemporary.resolve(dependency), { code: "MODULE_NOT_FOUND" }, `${dependency} must not resolve from the temporary application.`);
  }
  const harness = path.join(temporary, "check-import-health.mjs");
  await writeFile(harness, `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const { createApplication } = await import('./dist/index.js');
const server = createServer(createApplication());
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const response = await fetch('http://127.0.0.1:' + address.port + '/api/health', { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
`);
  await run("Compiled application import and HTTP health", process.execPath, [harness], temporary, 15_000);
  console.log("[production] Compiled application import and local HTTP health passed with no top-level Vite, tsx or TypeScript entry.");
  if (skipBrowser) {
    console.log("[production] Browser QA explicitly skipped; only the import and health diagnostic passed.");
  } else {
    await run("Compiled browser QA smoke suite", process.execPath, [path.join(temporary, "dist", "qa-smoke.js")], temporary, 240_000, true);
    console.log("[production] Complete compiled browser QA smoke suite passed with production dependencies only.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await Promise.allSettled([...children].map(stopTree));
  if (temporary) {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(error => {
      console.error(`Could not remove the production verification directory: ${error.message}`);
      process.exitCode = 1;
    });
  }
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
}
