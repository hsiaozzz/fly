import { appendFile } from "node:fs/promises";
import { chromium } from "playwright-core";
if (!process.env.GITHUB_ENV) throw new Error("This helper is for GitHub Actions only.");
await appendFile(process.env.GITHUB_ENV, `ARCANE_BROWSER_EXECUTABLE=${chromium.executablePath()}\n`);
