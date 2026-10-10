import { spawn } from "node:child_process";

const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", "3091", "--strictPort"], { stdio: "ignore" });
const baseUrl = "http://127.0.0.1:3091";
const run = filename => new Promise((resolve, reject) => {
  const process = spawn(globalThis.process.execPath, [filename], { stdio: "inherit", env: { ...globalThis.process.env, ARCANE_TEST_BASE_URL: baseUrl } });
  process.once("error", reject); process.once("exit", code => code === 0 ? resolve() : reject(new Error(`${filename} exited ${code}`)));
});
try {
  const deadline = Date.now() + 15_000;
  while (true) {
    try { if ((await fetch(baseUrl)).ok) break; } catch { /* Wait for preview readiness. */ }
    if (Date.now() > deadline) throw new Error("Production frontend preview did not become ready.");
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  await run("tools/workspace-smoke.mjs");
  await run("tools/project-smoke.mjs");
} finally { server.kill(); }
