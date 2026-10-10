import { access, appendFile } from "node:fs/promises";
import { constants } from "node:fs";
import { chromium } from "playwright-core";
if (!process.env.GITHUB_ENV)
  throw new Error("This helper is for GitHub Actions only.");
const browserPath = chromium.executablePath();
await access(browserPath, constants.X_OK);
// Verify that the runner can start the actual binary with its sandbox enabled.
const browser = await chromium.launch({
  executablePath: browserPath,
  headless: true,
  chromiumSandbox: true,
  timeout: 10_000,
});
await browser.close();
await appendFile(
  process.env.GITHUB_ENV,
  `ARCANE_BROWSER_EXECUTABLE=${browserPath}\n`
);
