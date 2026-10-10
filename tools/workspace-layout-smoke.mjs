import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { chromium } from "playwright-core";
import {
  browserExecutable,
  settlePreviewLayout,
  within,
} from "./browser-smoke-helpers.mjs";

let server = null;
let browser;
async function run() {
  await access(new URL("../dist/public/index.html", import.meta.url));
  server = process.env.ARCANE_TEST_BASE_URL
    ? null
    : await preview({
        configFile: fileURLToPath(
          new URL("../vite.config.ts", import.meta.url)
        ),
        logLevel: "warn",
        preview: { host: "127.0.0.1", port: 0, strictPort: true },
      });
  const baseUrl =
    process.env.ARCANE_TEST_BASE_URL ||
    server?.resolvedUrls?.local.find(
      url => new URL(url).hostname === "127.0.0.1"
    );
  browser = await chromium.launch({
    executablePath: browserExecutable(),
    headless: true,
    chromiumSandbox: true,
    timeout: 15_000,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  const forbiddenRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/api/capabilities", route => {
    const missing = {
      configured: false,
      status: "missing",
      verification: "unverified",
    };
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: 1,
        generation: missing,
        authentication: missing,
        cloudProjects: missing,
        browserQa: missing,
        database: missing,
        objectStorage: missing,
      }),
    });
  });
  await context.route("**/api/trpc/**", route => {
    if (route.request().method() !== "GET")
      forbiddenRequests.push(route.request().url());
    const procedures = new URL(route.request().url()).pathname
      .split("/api/trpc/")[1]
      .split(",");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        procedures.map(() => ({ result: { data: { json: null } } }))
      ),
    });
  });
  await context.route("**/api/game/**", route => {
    forbiddenRequests.push(route.request().url());
    return route.abort();
  });
  const authorArtifact = {
    title: "作者布局验证",
    description: "浏览器布局 fixture",
    controls: ["向下滚动查看完整页面"],
    files: [
      {
        path: "index.html",
        language: "html",
        content:
          '<!doctype html><html><head><meta charset="UTF-8"><style>html,body{height:auto;overflow:visible}body{height:900px;margin:0;background:rgb(35,64,81);color:white}</style></head><body><h1>作者布局验证</h1><p>这张页面由作者设定高度、背景和滚动方式。</p></body></html>',
      },
    ],
  };
  await page.addInitScript(artifact => {
    if (window.top !== window) return;
    const documentId = "layout-author-fixture";
    const document = {
      documentId,
      projectId: null,
      baseVersionId: null,
      revision: 1,
      savedRevision: 0,
      dirty: true,
      artifact,
      build: { status: "pending", attempts: 1, repairApplied: false, logs: [] },
      validation: null,
      trace: [],
      intent: "",
      messages: [
        {
          id: "layout-author-message",
          role: "system",
          content: "浏览器布局验收样例",
        },
      ],
      undo: [],
      lastChange: null,
    };
    localStorage.setItem(
      "arcane.workspace.v2.guest",
      JSON.stringify({
        format: 2,
        activeDocumentId: documentId,
        documents: { [documentId]: document },
      })
    );
  }, authorArtifact);

  async function readPreviewLayout() {
    await settlePreviewLayout(page);
    const iframe = page.locator('iframe[title="游戏隔离预览"]');
    const frame = await (await iframe.elementHandle()).contentFrame();
    // The iframe paints independently after host resizing and font layout.
    for (const target of [page, frame]) {
      await target.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        );
      });
    }
    const host = await iframe.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    const content = await frame.evaluate(() => {
      const bounds = selector => {
        const element = document.querySelector(selector);
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
          display: style.display,
          visibility: style.visibility,
        };
      };
      return {
        width: innerWidth,
        height: innerHeight,
        scrollX,
        scrollY,
        canvas: bounds("#game-canvas"),
        start: bounds("#start"),
        restart: bounds("#restart"),
      };
    });
    assert.ok(
      Math.abs(host.width - content.width) < 2,
      "iframe 内容宽度与实际预览宽度一致"
    );
    assert.ok(
      Math.abs(host.height - content.height) < 2,
      "iframe 内容高度与实际预览高度一致"
    );
    assert.equal(content.scrollX, 0);
    assert.equal(content.scrollY, 0, "开始前不需要自动滚动 iframe");
    for (const name of ["canvas", "start", "restart"]) {
      const element = content[name];
      assert.ok(
        element.width > 0 &&
          element.height > 0 &&
          element.display !== "none" &&
          element.visibility === "visible",
        `${name} 实际可见`
      );
      assert.ok(
        element.x >= -1 &&
          element.y >= -1 &&
          element.right <= content.width + 1 &&
          element.bottom <= content.height + 1,
        `${name} 完整位于 iframe 内：${JSON.stringify(element)}, frame ${content.width}×${content.height}`
      );
    }
    return { host, content };
  }

  if (!baseUrl) throw new Error("没有可用的生产前端预览地址。");
  const homePage = await context.newPage();
  homePage.on("pageerror", error => errors.push(error.message));
  await homePage.goto(baseUrl);
  await homePage.getByRole("heading", { name: /你的下一个游戏/ }).waitFor();
  await homePage.getByText("本地工作台可用", { exact: true }).waitFor();
  assert.equal(
    await homePage.locator(".monaco-editor").count(),
    0,
    "首页不加载源码编辑器"
  );
  assert.equal(
    await homePage.locator('iframe[title="游戏隔离预览"]').count(),
    0,
    "首页不展示空试玩框"
  );
  await mkdir("docs/ui-payments-2026-10-10", { recursive: true });
  await homePage.screenshot({
    path: "docs/ui-payments-2026-10-10/home-desktop.png",
    fullPage: true,
  });
  await homePage.setViewportSize({ width: 390, height: 844 });
  await homePage.screenshot({
    path: "docs/ui-payments-2026-10-10/home-mobile.png",
    fullPage: true,
  });
  await homePage.setViewportSize({ width: 330, height: 430 });
  const homeLayout = await homePage.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(
    homeLayout.document <= homeLayout.viewport &&
      homeLayout.body <= homeLayout.viewport,
    "330px 首页无横向溢出"
  );
  for (const action of ["体验示例", "创作额度", "New Game"]) {
    const rect = await homePage
      .locator(".header-actions")
      .getByRole("button", { name: action, exact: true })
      .boundingBox();
    assert.ok(
      rect.x >= 0 && rect.x + rect.width <= 330,
      `${action} 在窄手机可达`
    );
  }
  await homePage.screenshot({
    path: "docs/ui-payments-2026-10-10/home-compact.png",
    fullPage: true,
  });
  await homePage.close();
  await page.goto(baseUrl);
  await page
    .getByRole("heading", { name: authorArtifact.title, exact: true })
    .waitFor();
  const authorFrame = await (
    await page.locator('iframe[title="游戏隔离预览"]').elementHandle()
  ).contentFrame();
  await authorFrame
    .getByRole("heading", { name: authorArtifact.title, exact: true })
    .waitFor();
  const authored = await authorFrame.evaluate(() => {
    const body = getComputedStyle(document.body);
    return {
      background: body.backgroundColor,
      height: body.height,
      overflow: body.overflowY,
    };
  });
  assert.deepEqual(
    authored,
    { background: "rgb(35, 64, 81)", height: "900px", overflow: "visible" },
    "作者样式优先于预览默认样式"
  );
  await page
    .locator(".header-actions")
    .getByRole("button", { name: "体验示例", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "苹果小果园 · 预置示例", exact: true })
    .waitFor();
  await page
    .frameLocator('iframe[title="游戏隔离预览"]')
    .locator("#game-canvas")
    .waitFor();
  const persistentFrame = await page
    .locator('iframe[title="游戏隔离预览"]')
    .elementHandle();
  const modeLayouts = {};
  for (const mode of [/^Files/, "参数", "QA", "游戏文档", "试玩"]) {
    await page
      .getByRole("button", { name: mode, exact: typeof mode === "string" })
      .click();
    assert.equal(
      await persistentFrame.evaluate(
        element =>
          element.isConnected &&
          element === document.querySelector('iframe[title="游戏隔离预览"]')
      ),
      true,
      "模式切换保持同一游戏iframe"
    );
    modeLayouts[String(mode)] = await readPreviewLayout();
    if (mode instanceof RegExp)
      await page.screenshot({
        path: "docs/ui-payments-2026-10-10/source-desktop.png",
        fullPage: true,
      });
  }
  const desktop = await readPreviewLayout();
  await mkdir("docs/ui-payments-2026-10-10", { recursive: true });
  await page.screenshot({
    path: "docs/ui-payments-2026-10-10/layout-workspace-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "手机预览", exact: true }).click();
  const mobile = await readPreviewLayout();
  await page.screenshot({
    path: "docs/ui-payments-2026-10-10/layout-workspace-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 330, height: 430 });
  const compact = await readPreviewLayout();
  await page.getByRole("button", { name: /^Files/ }).click();
  const compactSource = await readPreviewLayout();
  await page.locator(".monaco-editor textarea").first().waitFor();
  await page.screenshot({
    path: "docs/ui-payments-2026-10-10/source-compact.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "试玩", exact: true }).click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    "330px 工作台无横向溢出"
  );
  await page.screenshot({
    path: "docs/ui-payments-2026-10-10/layout-workspace-compact.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "桌面预览", exact: true }).click();
  const returnedDesktop = await readPreviewLayout();
  assert.ok(
    returnedDesktop.content.canvas.width > mobile.content.canvas.width,
    "切回桌面后游戏按实际宽度重新布局"
  );
  assert.deepEqual(errors, [], "真实工作台布局没有未捕获错误");
  assert.deepEqual(forbiddenRequests, [], "布局验证没有模型或云端写入请求");
  await writeFile(
    "docs/ui-payments-2026-10-10/workspace-layout-results.json",
    JSON.stringify(
      {
        source: "offline preset and authored layout browser fixtures",
        authored,
        desktop,
        mobile,
        compact,
        compactSource,
        modeLayouts,
        homeLayout,
        returnedDesktop,
        forbiddenRequests,
        errors,
      },
      null,
      2
    )
  );
  console.log(
    "Workspace layout smoke passed: authored CSS, full canvas/start/restart visibility, desktop/mobile/desktop resizing, no generation or cloud writes."
  );
}
try {
  await within(run(), "Workspace layout smoke", 90_000);
} finally {
  await browser?.close();
  await server?.close();
}
