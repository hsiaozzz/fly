import { access, appendFile } from "node:fs/promises";
import { constants } from "node:fs";
import { chromium } from "playwright-core";
if (!process.env.GITHUB_ENV)
  throw new Error("This helper is for GitHub Actions only.");
const browserPath = chromium.executablePath();
await access(browserPath, constants.X_OK);
await appendFile(
  process.env.GITHUB_ENV,
  `ARCANE_BROWSER_EXECUTABLE=${browserPath}\n`
);
