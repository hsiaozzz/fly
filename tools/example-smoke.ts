import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type CDPSession, type Frame, type Page } from "playwright-core";
import { artifactDigest } from "../shared/game/artifact";
import { bundleGameArtifact } from "../shared/game/bundle";
import { createExampleArtifact } from "../shared/game/exampleArtifact";

/** Scenario for the bundled offline example, using rendered pixels and real input. */
const artifact = createExampleArtifact();
const artifactHash = await artifactDigest(artifact);
const html = bundleGameArtifact(artifact).html;
const evidenceDirectory = path.resolve(process.env.ARCANE_EXAMPLE_EVIDENCE_DIR || "docs/local-preview-2026-10-10/example-game");
const executablePath = process.env.ARCANE_BROWSER_EXECUTABLE || [
  chromium.executablePath(),
  ...(process.platform === "win32"
    ? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]
    : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]),
].find(existsSync);
assert.ok(executablePath, "Chromium is required for the real example scenario.");

type Pixels = {
  width: number; height: number;
  basket: { x: number; y: number; width: number } | null;
  apples: Array<{ x: number; y: number; pixels: number }>;
  coloredPixels: number;
};
type Hud = { state: string; caught: number; missed: number; status: string };
type Layout = { scrollX: number; scrollY: number; elements: Array<{ selector: string; x: number; y: number; width: number; height: number; hit: boolean; visible: boolean }> };
type ScenarioRecord = { mode: "layout-only" | "gameplay"; viewport: { width: number; height: number }; input?: "keyboard" | "touch"; layout: Layout; checks: string[]; win?: Hud; loss?: Hud; runtimeErrors: number; networkRequests: number };
const records: ScenarioRecord[] = [];
const deadline = Date.now() + 120_000;
const browser = await chromium.launch({
  executablePath, headless: true, chromiumSandbox: true, timeout: 10_000,
  args: ["--disable-background-networking", "--disable-extensions", "--mute-audio"],
});
const timeout = setTimeout(() => { void browser.close(); }, Math.max(1, deadline - Date.now()));

async function readHud(frame: Frame): Promise<Hud> {
  return frame.evaluate(() => ({
    state: document.querySelector("#game-status")?.getAttribute("data-state") || document.body.dataset.state || "",
    caught: Number(document.querySelector("#caught")?.textContent),
    missed: Number(document.querySelector("#missed")?.textContent),
    status: document.querySelector("#game-status")?.textContent || "",
  }));
}

/** Bounding boxes and painted hit targets must be visible before any input. */
async function checkLayout(frame: Frame, viewport: { width: number; height: number }): Promise<Layout> {
  const layout = await frame.evaluate(() => ({
    scrollX: window.scrollX, scrollY: window.scrollY,
    elements: ["#game-canvas", "#start", "#restart", "#move-left", "#move-right"].map(selector => {
      const element = document.querySelector(selector);
      if (!element) throw new Error("Required example interface missing.");
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      const points = selector === "#game-canvas" ? [[0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9], [0.5, 0.5]] : [[0.5, 0.5]];
      return {
        selector, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        visible: style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0,
        hit: points.every(([x, y]) => { const painted = document.elementFromPoint(rect.x + rect.width * x, rect.y + rect.height * y); return painted !== null && element.contains(painted); }),
      };
    }),
  }));
  assert.equal(layout.scrollX, 0, "The initial game interface must not need horizontal scrolling.");
  assert.equal(layout.scrollY, 0, "The game must not scroll to expose a control.");
  for (const element of layout.elements) {
    assert.ok(element.visible && element.hit, `${element.selector} must be painted and reachable before scrolling.`);
    assert.ok(element.width > 20 && element.height > 20, `${element.selector} must have a usable surface.`);
    assert.ok(element.x >= -1 && element.y >= -1 && element.x + element.width <= viewport.width + 1 && element.y + element.height <= viewport.height + 1, `${element.selector} must fit wholly within the ${viewport.width}x${viewport.height} preview.`);
  }
  return layout;
}

async function clickWithoutScrolling(page: Page, frame: Frame, selector: string, viewport: { width: number; height: number }, touch: boolean) {
  await checkLayout(frame, viewport);
  const box = await frame.locator(selector).boundingBox(); assert.ok(box);
  // Coordinates cannot ask Playwright to scroll a hidden control into view.
  if (touch) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await frame.evaluate(() => window.scrollY), 0, "Real input must not scroll the game interface.");
}

/** No game variables or diagnostic attributes are used to steer the player. */
async function readPixels(frame: Frame): Promise<Pixels> {
  return frame.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas");
    if (!canvas) throw new Error("Example canvas missing.");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Example Canvas2D unavailable.");
    const { width, height } = canvas;
    const { data } = context.getImageData(0, 0, width, height);
    const red = new Uint8Array(width * height);
    let basketX = 0, basketY = 0, basketCount = 0, minimumX = width, maximumX = 0, coloredPixels = 0;
    for (let index = 0; index < width * height; index++) {
      const offset = index * 4, r = data[offset], g = data[offset + 1], b = data[offset + 2];
      if (r > 185 && g < 135 && b < 155 && data[offset + 3] > 200) red[index] = 1;
      if (g > 145 && b > 115 && r < 150 && g - r > 55 && b - r > 35 && data[offset + 3] > 200) {
        const x = index % width, y = Math.floor(index / width);
        basketX += x; basketY += y; basketCount++; minimumX = Math.min(minimumX, x); maximumX = Math.max(maximumX, x);
      }
      if (Math.max(r, g, b) - Math.min(r, g, b) > 35 && Math.max(r, g, b) > 140) coloredPixels++;
    }
    const apples: Pixels["apples"] = [];
    for (let index = 0; index < red.length; index++) {
      if (red[index] !== 1) continue;
      const queue = [index]; red[index] = 2;
      let xTotal = 0, yTotal = 0;
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const current = queue[cursor], x = current % width, y = Math.floor(current / width);
        xTotal += x; yTotal += y;
        for (const next of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1, y > 0 ? current - width : -1, y + 1 < height ? current + width : -1]) {
          if (next >= 0 && red[next] === 1) { red[next] = 2; queue.push(next); }
        }
      }
      if (queue.length >= 20) apples.push({ x: xTotal / queue.length, y: yTotal / queue.length, pixels: queue.length });
    }
    return { width, height, basket: basketCount ? { x: basketX / basketCount, y: basketY / basketCount, width: maximumX - minimumX + 1 } : null, apples, coloredPixels };
  });
}

async function makeController(page: Page, frame: Frame, touch: boolean) {
  let held = 0;
  const session: CDPSession | undefined = touch ? await page.context().newCDPSession(page) : undefined;
  const points = touch ? await Promise.all(["#move-left", "#move-right"].map(async selector => {
    const box = await frame.locator(selector).boundingBox();
    assert.ok(box, `${selector} must be visible for touch input.`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, radiusX: 5, radiusY: 5, force: 1, id: 1 };
  })) : [];
  const release = async () => {
    if (!held) return;
    if (session) await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    else await page.keyboard.up(held < 0 ? "ArrowLeft" : "ArrowRight");
    held = 0;
  };
  return {
    async move(direction: number) {
      if (direction === held) return;
      await release();
      if (!direction) return;
      if (session) await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[direction < 0 ? 0 : 1]] });
      else await page.keyboard.down(direction < 0 ? "ArrowLeft" : "ArrowRight");
      held = direction;
    },
    release,
    async dispose() { await release(); await session?.detach(); },
  };
}

async function runScenario(viewport: { width: number; height: number }, layoutOnly = false) {
  const touch = viewport.width < 500;
  const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, serviceWorkers: "block", acceptDownloads: false, permissions: [] });
  const page = await context.newPage();
  const runtimeErrors: string[] = [], networkRequests: string[] = [];
  page.on("pageerror", error => runtimeErrors.push(error.name));
  await context.route("**/*", route => {
    if (/^(?:about:|data:|blob:)/.test(route.request().url())) return route.continue();
    networkRequests.push(new URL(route.request().url()).protocol);
    return route.abort();
  });
  try {
    // Load the exact bundle in the same opaque-origin script-only sandbox as preview.
    const escapedHtml = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    await page.setContent(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe title="离线接苹果示例" sandbox="allow-scripts" style="display:block;border:0;width:100vw;height:100vh" srcdoc="${escapedHtml}"></iframe></body></html>`, { waitUntil: "load", timeout: 6000 });
    const frame = page.frames().find(candidate => candidate !== page.mainFrame());
    assert.ok(frame, "The actual game sandbox must exist.");
    await frame.locator("#start").waitFor({ state: "visible" });
    const layout = await checkLayout(frame, viewport);
    const canvasBox = await frame.locator("#game-canvas").boundingBox();
    assert.ok(canvasBox && canvasBox.width > 100 && canvasBox.height > 100, "Canvas must occupy a visible game surface.");
    assert.ok(canvasBox.x >= 0 && canvasBox.x + canvasBox.width <= viewport.width + 1 && canvasBox.y + canvasBox.height <= viewport.height + 1, "Canvas must fit the desktop/mobile viewport.");
    const initialPixels = await readPixels(frame);
    assert.ok(initialPixels.basket && initialPixels.coloredPixels > 1000, "The canvas must contain a rendered basket and colored game scene.");
    if (layoutOnly) {
      const initial = await readHud(frame); assert.equal(initial.state, "ready");
      assert.equal(initial.caught, 0); assert.equal(initial.missed, 0);
      assert.deepEqual(runtimeErrors, []); assert.deepEqual(networkRequests, []);
      await page.screenshot({ path: path.join(evidenceDirectory, `layout-${viewport.width}x${viewport.height}.png`) });
      records.push({ mode: "layout-only", viewport, layout, checks: ["complete-canvas-without-scroll", "start-restart-reachable-without-scroll", "direction-controls-reachable-without-scroll", "painted-pixel-scene", "no-runtime-errors", "offline"], runtimeErrors: 0, networkRequests: 0 });
      return;
    }
    const initial = await readHud(frame);
    assert.equal(initial.state, "ready");
    assert.equal(initial.caught, 0); assert.equal(initial.missed, 0);
    await page.waitForTimeout(350);
    assert.deepEqual(await readHud(frame), initial, "The game must wait for the visible start action.");
    await clickWithoutScrolling(page, frame, "#start", viewport, touch);
    assert.equal((await readHud(frame)).state, "playing");
    const controller = await makeController(page, frame, touch);
    try {
      const before = (await readPixels(frame)).basket; assert.ok(before);
      await controller.move(1); await page.waitForTimeout(180); await controller.release();
      const right = (await readPixels(frame)).basket; assert.ok(right && right.x > before.x + 10, "Real right input must move the painted basket right.");
      await controller.move(-1); await page.waitForTimeout(180); await controller.release();
      const left = (await readPixels(frame)).basket; assert.ok(left && left.x < right.x - 10, "Real left input must move the painted basket left.");

      const driveUntil = async (outcome: "win" | "lose") => {
        while (Date.now() < deadline) {
          const hud = await readHud(frame);
          assert.ok(Number.isInteger(hud.caught) && Number.isInteger(hud.missed), "The visible counters must remain numeric.");
          if (hud.caught >= 10 || hud.missed >= 3) { await controller.release(); return hud; }
          const pixels = await readPixels(frame); assert.ok(pixels.basket, "The actual basket must remain painted during play.");
          const apple = pixels.apples.filter(candidate => candidate.y < pixels.basket!.y + 10).sort((a, b) => b.y - a.y)[0];
          if (apple) {
            const target = outcome === "win" ? apple.x : apple.x < pixels.width / 2 ? pixels.width - 20 : 20;
            const delta = target - pixels.basket.x;
            await controller.move(Math.abs(delta) < Math.max(8, pixels.basket.width * 0.18) ? 0 : delta < 0 ? -1 : 1);
          } else await controller.release();
          await page.waitForTimeout(35);
        }
        throw new Error("The real gameplay scenario exceeded its 120-second deadline.");
      };

      const win = await driveUntil("win");
      assert.equal(win.state, "won");
      assert.equal(win.caught, 10, "Catching exactly ten rendered apples must win.");
      assert.ok(win.missed < 3, "The win must happen before three missed apples.");
      assert.match(win.status, /胜利|获胜|成功/);
      await page.screenshot({ path: path.join(evidenceDirectory, `${touch ? "mobile" : "desktop"}-win.png`) });
      await clickWithoutScrolling(page, frame, "#restart", viewport, touch);
      const afterWinRestart = await readHud(frame);
      assert.equal(afterWinRestart.state, "playing");
      assert.equal(afterWinRestart.caught, 0); assert.equal(afterWinRestart.missed, 0);
      assert.doesNotMatch(afterWinRestart.status, /胜利|获胜|失败/);
      const loss = await driveUntil("lose");
      assert.equal(loss.state, "lost");
      assert.equal(loss.missed, 3, "Missing exactly three rendered apples must lose.");
      assert.ok(loss.caught < 10); assert.match(loss.status, /失败/);
      await page.screenshot({ path: path.join(evidenceDirectory, `${touch ? "mobile" : "desktop"}-loss.png`) });
      await clickWithoutScrolling(page, frame, "#restart", viewport, touch);
      const afterLossRestart = await readHud(frame);
      assert.equal(afterLossRestart.state, "playing");
      assert.equal(afterLossRestart.caught, 0); assert.equal(afterLossRestart.missed, 0);
      assert.doesNotMatch(afterLossRestart.status, /胜利|获胜|失败/);
      assert.deepEqual(runtimeErrors, [], "No runtime errors are acceptable.");
      assert.deepEqual(networkRequests, [], "The offline example must not request network resources.");
      await checkLayout(frame, viewport);
      records.push({ mode: "gameplay", viewport, input: touch ? "touch" : "keyboard", layout, checks: ["complete-canvas-without-scroll", "start-restart-reachable-without-scroll", "start-gate", "real-left-right-input", "catch-10-win", "miss-3-lose", "restart-resets-win-and-loss", "no-runtime-errors", "offline"], win, loss, runtimeErrors: runtimeErrors.length, networkRequests: networkRequests.length });
    } finally { await controller.dispose(); }
  } finally { await context.close(); }
}

try {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(path.join(evidenceDirectory, "artifact.json"), JSON.stringify(artifact, null, 2));
  for (const viewport of [{ width: 848, height: 348 }, { width: 330, height: 430 }]) await runScenario(viewport, true);
  for (const viewport of [{ width: 960, height: 640 }, { width: 390, height: 844 }]) await runScenario(viewport);
  const report = { schemaVersion: 1, status: "passed", artifactHash, method: "browser-scenario", chromiumSandbox: true, gameSandbox: "allow-scripts", modelsCalled: 0, testedAt: new Date().toISOString(), scenarios: records };
  await writeFile(path.join(evidenceDirectory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: "example_scenario_passed", artifactHash, scenarios: records.length, modelsCalled: 0, chromiumSandbox: true }));
} catch (error) {
  await writeFile(path.join(evidenceDirectory, "report.json"), JSON.stringify({ schemaVersion: 1, status: "failed", artifactHash, method: "browser-scenario", chromiumSandbox: true, modelsCalled: 0, testedAt: new Date().toISOString(), completedScenarios: records, errorCategory: "scenario-failed" }, null, 2)).catch(() => {});
  throw error;
} finally { clearTimeout(timeout); await browser.close(); }
