import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "watch", "server/_core/index.ts"], { stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } });
child.once("exit", code => { process.exitCode = code ?? 1; });
