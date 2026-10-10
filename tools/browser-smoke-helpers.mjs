import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

export function browserExecutable() {
  if (process.env.ARCANE_BROWSER_EXECUTABLE)
    return process.env.ARCANE_BROWSER_EXECUTABLE;
  return [
    chromium.executablePath(),
    ...(process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : [
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/google-chrome",
        ]),
  ].find(existsSync);
}

export async function within(promise, description, timeoutMs = 15_000) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${description} timed out.`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** A UI loading indicator can appear before its request reaches the fixture. */
export function routeGate(description) {
  let enter, finish, release;
  const entered = new Promise(resolve => {
    enter = resolve;
  });
  const finished = new Promise(resolve => {
    finish = resolve;
  });
  const released = new Promise(resolve => {
    release = resolve;
  });
  return {
    async hold() {
      enter();
      await released;
    },
    release,
    finish,
    waitUntilEntered() {
      return within(entered, `${description} request arrival`);
    },
    waitUntilFinished() {
      return within(finished, `${description} fixture completion`);
    },
  };
}

export async function settlePreviewLayout(page) {
  await page.locator(".preview-frame-wrap").evaluate(async element => {
    // Resize transitions may start on the next rendering frame.
    await new Promise(resolve => requestAnimationFrame(resolve));
    await Promise.all(
      element.getAnimations().map(animation => animation.finished)
    );
  });
}
