import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import JSZip from "jszip";
import {
  browserExecutable,
  routeGate,
  settlePreviewLayout,
} from "./browser-smoke-helpers.mjs";

const baseUrl = process.env.ARCANE_TEST_BASE_URL || "http://127.0.0.1:3090";
const executablePath = browserExecutable();
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({
  acceptDownloads: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const configuredCapability = {
  configured: true,
  status: "configured",
  verification: "unverified",
};
let capabilityMode = "ready";
let generationCalls = 0;
let cloudWrites = 0;
const capabilityGate = routeGate("capability loading");
await context.route("**/api/capabilities", async route => {
  if (capabilityMode === "loading") await capabilityGate.hold();
  if (capabilityMode === "error")
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "PRIVATE_DIAGNOSTIC_NOT_FOR_UI" }),
    });
  if (capabilityMode === "legacy")
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ready: true }),
    });
  const state =
    capabilityMode === "missing"
      ? { configured: false, status: "missing", verification: "unverified" }
      : configuredCapability;
  const body = {
    schemaVersion: 1,
    generation: state,
    authentication: state,
    cloudProjects: state,
    browserQa: state,
    database: state,
    objectStorage: state,
  };
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  if (capabilityMode === "loading") capabilityGate.finish();
});
await context.route("**/api/trpc/**", async route => {
  const procedures = new URL(route.request().url()).pathname
    .split("/api/trpc/")[1]
    .split(",");
  if (route.request().method() === "POST") cloudWrites += procedures.length;
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(
      procedures.map(() => ({ result: { data: { json: null } } }))
    ),
  });
});
const pendingStream = routeGate("cancelled workspace generation");
const source = label =>
  `<!doctype html><html><head><title>浏览器验收</title></head><body><button id="button">${label}</button><script>document.querySelector('button').addEventListener('click',e=>e.target.textContent='已点击')</script></body></html>`;
const artifact = {
  title: "工作台验收样例",
  description: "fixture",
  controls: ["点击按钮"],
  files: [
    { path: "index.html", content: source("原始按钮"), language: "html" },
  ],
};
// Observe the rendered basket lip; do not rely on a game variable or test hook.
function renderedBasket({ min = 0, max = 560 } = {}) {
  const canvas = document.querySelector("#game-canvas");
  if (!canvas) return false;
  const pixels = canvas
    .getContext("2d")
    .getImageData(0, canvas.height - 50, canvas.width, 1).data;
  let count = 0,
    sum = 0;
  for (let x = 0; x < canvas.width; x++) {
    const i = x * 4;
    if (pixels[i] === 181 && pixels[i + 1] === 255 && pixels[i + 2] === 241) {
      count++;
      sum += x;
    }
  }
  if (count < 20) return false;
  const center = sum / count;
  return center >= min && center <= max ? { center, pixels: count } : false;
}
await context.route("**/api/game/stream", async route => {
  generationCalls++;
  const input = route.request().postDataJSON();
  const delayed = input.prompt.includes("慢任务");
  if (delayed) await pendingStream.hold();
  const result = {
    artifact,
    build: {
      status: "pending",
      attempts: 1,
      repairApplied: false,
      logs: ["浏览器验收待执行"],
    },
    trace: [{ agent: "Creator", status: "done", detail: "已生成" }],
    assistantMessage: "样例已生成，浏览器验收待完成",
    runId: input.runId,
  };
  const event = (event, data) =>
    `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
  try {
    await route
      .fulfill({
        contentType: "text/event-stream",
        body:
          event("status", {
            agent: "Creator",
            status: "running",
            detail: "正在生成",
          }) + event("complete", result),
      })
      .catch(() => {});
  } finally {
    if (delayed) pendingStream.finish();
  }
});
try {
  await page.goto(baseUrl);
  const composer = page.locator(".composer textarea");
  await composer.fill("制作点击按钮游戏");
  await page.getByRole("button", { name: "生成游戏", exact: true }).click();
  await page
    .getByRole("heading", { name: artifact.title, exact: true })
    .waitFor();
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "原始按钮", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "停止", exact: true })
    .waitFor({ state: "hidden" });
  await page
    .locator(".monaco-editor textarea")
    .first()
    .waitFor({ timeout: 30_000 });
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(source("编辑后按钮"));
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "编辑后按钮", exact: true })
    .waitFor();
  await page.evaluate(() =>
    window.postMessage({ source: "arcane-runtime-probe", report: {} }, "*")
  );
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download ZIP/ }).click();
  const download = await downloadEvent;
  const zip = await JSZip.loadAsync(await readFile(await download.path()));
  assert.match(await zip.file("index.html").async("string"), /编辑后按钮/);
  assert.match(
    await zip.file("__arcane__/play.html").async("string"),
    /编辑后按钮/
  );
  const exported = JSON.parse(
    await zip.file("__arcane__/artifact.json").async("string")
  );
  assert.match(exported.files[0].content, /编辑后按钮/);
  assert.equal(
    await zip.file("index.html").async("string"),
    exported.files[0].content,
    "导出manifest与源文件逐字一致"
  );
  await page.waitForFunction(expected => {
    const raw = localStorage.getItem("arcane.workspace.v2.guest");
    if (!raw) return false;
    const library = JSON.parse(raw);
    return (
      JSON.stringify(library.documents[library.activeDocumentId].artifact) ===
      expected
    );
  }, JSON.stringify(exported));
  const draft = await page.evaluate(() => {
    const library = JSON.parse(
      localStorage.getItem("arcane.workspace.v2.guest")
    );
    return library.documents[library.activeDocumentId].artifact;
  });
  assert.deepEqual(draft, exported, "恢复草稿与导出同一个快照");
  await page.reload();
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "编辑后按钮", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /New Game/ }).click();
  await composer.fill("慢任务制作按钮游戏");
  await page.getByRole("button", { name: "生成游戏", exact: true }).click();
  await pendingStream.waitUntilEntered();
  await page.getByRole("button", { name: "停止", exact: true }).waitFor();
  await page.getByRole("button", { name: /New Game/ }).click();
  pendingStream.release();
  await pendingStream.waitUntilFinished();
  await page.waitForTimeout(500);
  assert.equal(
    await page.locator('iframe[title="游戏隔离预览"]').count(),
    0,
    "取消后的旧结果不能覆盖新草稿"
  );
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await page
    .getByRole("button", { name: new RegExp(artifact.title) })
    .first()
    .click();
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "编辑后按钮", exact: true })
    .waitFor();
  await mkdir("docs/implementation-2026-10-10", { recursive: true });
  await page
    .locator('iframe[title="游戏隔离预览"]')
    .evaluate(element => element.scrollIntoView({ block: "center" }));
  await page.screenshot({
    path: "docs/implementation-2026-10-10/workspace-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "手机预览", exact: true }).click();
  await settlePreviewLayout(page);
  const mobileButton = page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "编辑后按钮", exact: true });
  await mobileButton.waitFor();
  await page
    .locator('iframe[title="游戏隔离预览"]')
    .evaluate(element => element.scrollIntoView({ block: "center" }));
  await mobileButton.click();
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "已点击", exact: true })
    .waitFor({ timeout: 5000 });
  await page.screenshot({
    path: "docs/implementation-2026-10-10/workspace-mobile.png",
    fullPage: true,
  });
  capabilityMode = "missing";
  await page.reload();
  await page.getByText("本地工作台可用", { exact: true }).waitFor();
  const loginCookies = (await context.cookies()).filter(cookie =>
    /oauth_state/.test(cookie.name)
  );
  assert.deepEqual(loginCookies, [], "缺登录配置时不创建OAuth nonce cookie");
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "编辑后按钮", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "应用修改", exact: true })
      .isDisabled(),
    true
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Save version", exact: true })
      .isDisabled(),
    true
  );
  assert.equal(
    await page.getByRole("button", { name: "发布", exact: true }).isDisabled(),
    true
  );
  assert.equal(
    await page
      .getByRole("button", { name: "登录", exact: true })
      .first()
      .isDisabled(),
    true
  );
  const beforeDisabledAction = generationCalls;
  await composer.fill("不应发起模型请求");
  await composer.press("Enter");
  await page
    .getByText("此站点尚未开启 AI 创作。已有草稿可继续编辑、试玩和下载。", {
      exact: true,
    })
    .waitFor();
  assert.equal(generationCalls, beforeDisabledAction);
  await page
    .locator(".monaco-editor textarea")
    .first()
    .waitFor({ timeout: 30_000 });
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(source("离线编辑按钮"));
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "离线编辑按钮", exact: true })
    .waitFor();
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "离线编辑按钮", exact: true })
    .click();
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "已点击", exact: true })
    .waitFor();
  const offlineDownloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download ZIP/ }).click();
  const offlineDownload = await offlineDownloadEvent;
  const offlineZip = await JSZip.loadAsync(
    await readFile(await offlineDownload.path())
  );
  assert.match(
    await offlineZip.file("index.html").async("string"),
    /离线编辑按钮/
  );
  await page.waitForFunction(() => {
    const library = JSON.parse(
      localStorage.getItem("arcane.workspace.v2.guest")
    );
    return library.documents[
      library.activeDocumentId
    ].artifact.files[0].content.includes("离线编辑按钮");
  });
  const originalLibrary = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("arcane.workspace.v2.guest"))
  );
  const beforeExampleGeneration = generationCalls;
  const beforeExampleCloudWrites = cloudWrites;
  await page
    .locator(".header-actions")
    .getByRole("button", { name: "体验示例", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "苹果小果园 · 预置示例", exact: true })
    .waitFor();
  await page
    .getByText(/预置示例 · 无需模型服务。这是随工作台提供的本地游戏/)
    .waitFor();
  const exampleLibrary = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("arcane.workspace.v2.guest"))
  );
  const exampleDocument =
    exampleLibrary.documents[exampleLibrary.activeDocumentId];
  assert.notEqual(
    exampleDocument.documentId,
    originalLibrary.activeDocumentId,
    "示例创建独立草稿"
  );
  assert.equal(exampleDocument.projectId, null);
  assert.equal(exampleDocument.baseVersionId, null);
  assert.equal(exampleDocument.dirty, true);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(originalLibrary.documents).map(id => [
        id,
        exampleLibrary.documents[id],
      ])
    ),
    originalLibrary.documents,
    "打开示例保留所有原有草稿及项目"
  );
  const examplePreview = page.frameLocator('iframe[title="游戏隔离预览"]');
  await examplePreview
    .getByRole("button", { name: "开始游戏", exact: true })
    .click();
  await examplePreview
    .locator('#game-status[data-state="playing"]')
    .waitFor();
  const exampleFrame = await (
    await page.locator('iframe[title="游戏隔离预览"]').elementHandle()
  ).contentFrame();
  const initialBasket = await exampleFrame.evaluate(renderedBasket, {});
  assert.ok(initialBasket, "预览确实画出了篮子");
  await page.keyboard.down("ArrowLeft");
  try {
    await exampleFrame.waitForFunction(
      renderedBasket,
      { max: initialBasket.center - 40 },
      { timeout: 5000 }
    );
  } finally {
    await page.keyboard.up("ArrowLeft");
  }
  const keyboardBasket = await exampleFrame.evaluate(renderedBasket, {});
  assert.ok(
    keyboardBasket.center <= initialBasket.center - 40,
    "键盘左键实际移动画布中的篮子"
  );
  const rightButton = examplePreview.getByRole("button", {
    name: "右移",
    exact: true,
  });
  await rightButton.scrollIntoViewIfNeeded();
  const rightBounds = await rightButton.boundingBox();
  assert.ok(rightBounds);
  const touchSession = await context.newCDPSession(page);
  try {
    await touchSession.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        {
          x: rightBounds.x + rightBounds.width / 2,
          y: rightBounds.y + rightBounds.height / 2,
          id: 1,
        },
      ],
    });
    await exampleFrame.waitForFunction(
      renderedBasket,
      { min: keyboardBasket.center + 40 },
      { timeout: 5000 }
    );
  } finally {
    await touchSession.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await touchSession.detach();
  }
  const touchBasket = await exampleFrame.evaluate(renderedBasket, {});
  assert.ok(
    touchBasket.center >= keyboardBasket.center + 40,
    "触摸右移按钮实际移动画布中的篮子"
  );
  await examplePreview
    .getByRole("button", { name: "重新开始", exact: true })
    .click();
  assert.equal(await examplePreview.locator("#caught").textContent(), "0");
  assert.equal(await examplePreview.locator("#missed").textContent(), "0");
  await mkdir("docs/local-preview-2026-10-10/ui", { recursive: true });
  await page.screenshot({
    path: "docs/local-preview-2026-10-10/ui/offline-example-mobile.png",
    fullPage: true,
  });
  await page.locator(".monaco-editor textarea").first().waitFor();
  await page.locator(".monaco-editor .view-lines").first().click();
  // A normal title edit avoids treating a multiline HTML paste as bracket typing.
  await page.keyboard.press("Control+f");
  await page
    .locator('.monaco-editor .find-widget [aria-label="Find"]')
    .fill("<h1>苹果小果园</h1>");
  await page
    .locator(".monaco-editor .find-widget .matchesCount")
    .filter({ hasText: "1 of 1" })
    .waitFor({ state: "attached" });
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowRight");
  for (let index = 0; index < 5; index++)
    await page.keyboard.press("ArrowLeft");
  for (let index = 0; index < 5; index++)
    await page.keyboard.press("Shift+ArrowLeft");
  const editedExampleSource = exampleDocument.artifact.files[0].content.replace(
    "<h1>苹果小果园</h1>",
    "<h1>我的本地小果园</h1>"
  );
  await page.keyboard.insertText("我的本地小果园");
  await examplePreview
    .getByRole("heading", { name: "我的本地小果园", exact: true })
    .waitFor();
  await page.waitForFunction(() => {
    const library = JSON.parse(
      localStorage.getItem("arcane.workspace.v2.guest")
    );
    return library.documents[
      library.activeDocumentId
    ].artifact.files[0].content.includes("<h1>我的本地小果园</h1>");
  });
  const editedExampleArtifact = await page.evaluate(() => {
    const library = JSON.parse(
      localStorage.getItem("arcane.workspace.v2.guest")
    );
    return library.documents[library.activeDocumentId].artifact;
  });
  assert.equal(
    editedExampleArtifact.files[0].content.replace(/\r\n/g, "\n"),
    editedExampleSource.replace(/\r\n/g, "\n"),
    "编辑示例标题保留完整入口源码"
  );
  assert.deepEqual(
    editedExampleArtifact.files.slice(1),
    exampleDocument.artifact.files.slice(1),
    "标题编辑不影响其他文件"
  );
  const exampleDownloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download ZIP/ }).click();
  const exampleDownload = await exampleDownloadEvent;
  const exampleZip = await JSZip.loadAsync(
    await readFile(await exampleDownload.path())
  );
  const exportedExample = JSON.parse(
    await exampleZip.file("__arcane__/artifact.json").async("string")
  );
  assert.deepEqual(
    exportedExample,
    editedExampleArtifact,
    "预置示例编辑、预览、导出与本地草稿一致"
  );
  assert.deepEqual(
    exportedExample.files.map(file => file.path),
    ["index.html", "style.css", "game.js"]
  );
  for (const file of exportedExample.files)
    assert.equal(
      await exampleZip.file(file.path).async("string"),
      file.content,
      `预置示例 ${file.path} 逐字导出`
    );
  assert.match(
    await exampleZip.file("__arcane__/play.html").async("string"),
    /game-canvas/
  );
  await page.reload();
  await page
    .getByRole("heading", { name: "苹果小果园 · 预置示例", exact: true })
    .waitFor();
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("heading", { name: "我的本地小果园", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await page
    .locator(".local-drafts")
    .getByRole("button", { name: new RegExp(artifact.title) })
    .click();
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .getByRole("button", { name: "离线编辑按钮", exact: true })
    .waitFor();
  assert.equal(
    generationCalls,
    beforeExampleGeneration,
    "打开、试玩、恢复和下载预置示例不调用模型 SSE"
  );
  assert.equal(cloudWrites, beforeExampleCloudWrites, "预置示例不写入云项目");
  for (const mode of ["error", "legacy"]) {
    capabilityMode = mode;
    await page.reload();
    await page.getByText("暂时无法确认在线功能", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "应用修改", exact: true })
        .isDisabled(),
      true
    );
    assert.equal(
      (await page.locator("body").innerText()).includes(
        "PRIVATE_DIAGNOSTIC_NOT_FOR_UI"
      ),
      false
    );
    const beforeErrorAction = generationCalls;
    await composer.fill("能力尚未确认时不发送请求");
    await composer.press("Enter");
    await page
      .getByText("暂时无法确认在线功能，请重试。", { exact: true })
      .waitFor();
    assert.equal(generationCalls, beforeErrorAction);
    capabilityMode = "ready";
    await page.getByRole("button", { name: "重新检查", exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector(".composer button")?.disabled
    );
  }
  capabilityMode = "loading";
  await page.reload();
  await capabilityGate.waitUntilEntered();
  await page.getByText("正在确认在线功能", { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "应用修改", exact: true })
      .isDisabled(),
    true
  );
  capabilityGate.release();
  await capabilityGate.waitUntilFinished();
  await page.getByRole("button", { name: "应用修改", exact: true }).waitFor();
  await composer.fill("在线功能恢复后的描述");
  await page.waitForFunction(
    () => !document.querySelector(".composer button")?.disabled
  );
  assert.deepEqual(errors, [], "工作台不能出现未捕获错误");
  console.log(
    "Workspace browser smoke passed: editing/preview/ZIP/recovery/cancel/new-game/history/forged-message/mobile/capabilities/offline-example keyboard+touch+ZIP."
  );
} finally {
  pendingStream.release();
  capabilityGate.release();
  await browser.close();
}
