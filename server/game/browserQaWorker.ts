import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import { bundleGameArtifact } from "../../shared/game/bundle";
import type { GameArtifact } from "../../shared/game/types";
import type {
  ValidationCheck,
  ValidationReport,
} from "../../shared/game/validation";

let browser: Browser | undefined;
const executable = () => {
  const configured = process.env.ARCANE_BROWSER_EXECUTABLE;
  if (configured) return configured;
  return (
    process.platform === "win32"
      ? [
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : [
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/google-chrome",
        ]
  ).find(existsSync);
};
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const wait = async (page: Page, ms: number) => {
  await page.clock.runFor(ms);
};
async function openGame(
  page: Page,
  html: string,
  seed: number
): Promise<Frame> {
  const seeded = `<script>(function(){var seed=${seed >>> 0};Math.random=function(){seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};})();</script>`;
  const source = html.replace(/<head>/i, `<head>${seeded}`);
  await page.setContent(
    `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><iframe sandbox="allow-scripts" style="border:0;width:100vw;height:100vh" srcdoc="<html><body></body></html>"></iframe></body></html>`,
    { waitUntil: "load", timeout: 6000 }
  );
  const frame = page.frames().find(frame => frame !== page.mainFrame());
  if (!frame) throw new Error("游戏 iframe 未创建。");
  // Install on an existing empty frame: a newly navigated frame replays clock
  // logs with real-time gaps, which otherwise shifts performance/RAF phases.
  // Writing into this same sandboxed window starts author code only after both
  // Date and performance clocks have reached the identical paused instant.
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  // Keep the existing window and clock; inspect readiness directly because a
  // synthetic document replacement can miss Playwright's lifecycle event.
  await frame.evaluate(source => {
    document.open();
    document.write(source);
    document.close();
  }, source);
  const deadline = Date.now() + 6000;
  while (await frame.evaluate(() => document.readyState !== "complete")) {
    if (Date.now() > deadline) throw new Error("游戏文档初始化超时。");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await wait(page, 160);
  return frame;
}
async function startGame(frame: Frame) {
  const { startIndex } = await frame.evaluate(visibleInterface);
  if (startIndex !== -1)
    await frame
      .locator("button, [role=button]")
      .nth(startIndex)
      .click({ timeout: 1500 });
}
/** Runs in the game frame; attributes alone are never rendering evidence. */
function visibleInterface() {
  type Rect = { left: number; top: number; right: number; bottom: number };
  const visibility = {
    intersects(rect: Rect, clip: Rect): Rect {
      return {
        left: Math.max(rect.left, clip.left),
        top: Math.max(rect.top, clip.top),
        right: Math.min(rect.right, clip.right),
        bottom: Math.min(rect.bottom, clip.bottom),
      };
    },
    present(rect: Rect) {
      return rect.right > rect.left && rect.bottom > rect.top;
    },
    nontransparent(color: string) {
      return (
        color !== "transparent" &&
        !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color)
      );
    },
    exposed(element: Element, rect: Rect) {
      // Hit-testing is a conservative visibility filter. Pixel comparison below
      // also rejects changes behind overlays with pointer-events:none.
      for (const x of [0.15, 0.5, 0.85]) {
        for (const y of [0.15, 0.5, 0.85]) {
          const hit = document.elementFromPoint(
            rect.left + (rect.right - rect.left) * x,
            rect.top + (rect.bottom - rect.top) * y
          );
          if (hit && (element.contains(hit) || hit.contains(element)))
            return true;
        }
      }
      return false;
    },
    effects(element: Element) {
      const effects = [];
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        effects.push([style.opacity, style.filter, style.mixBlendMode]);
      }
      return effects;
    },
    rect(
      element: Element,
      original = element.getBoundingClientRect()
    ): Rect | null {
      let rect: Rect = visibility.intersects(original, {
        left: 0,
        top: 0,
        right: innerWidth,
        bottom: innerHeight,
      });
      if (!element.isConnected || !visibility.present(rect)) return null;
      for (
        let ancestor: Element | null = element;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number(style.opacity) === 0 ||
          style.contentVisibility === "hidden"
        )
          return null;
        const box = ancestor.getBoundingClientRect();
        if (ancestor !== element) {
          const clipping = {
            left: -Infinity,
            top: -Infinity,
            right: Infinity,
            bottom: Infinity,
          };
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowX)) {
            clipping.left = box.left + ancestor.clientLeft;
            clipping.right = clipping.left + ancestor.clientWidth;
          }
          if (["hidden", "clip", "auto", "scroll"].includes(style.overflowY)) {
            clipping.top = box.top + ancestor.clientTop;
            clipping.bottom = clipping.top + ancestor.clientHeight;
          }
          rect = visibility.intersects(rect, clipping);
        }
        const legacyClip = style.clip.match(
          /^rect\(\s*(-?[\d.]+)px[, ]+(-?[\d.]+)px[, ]+(-?[\d.]+)px[, ]+(-?[\d.]+)px\s*\)$/
        );
        if (legacyClip)
          rect = visibility.intersects(rect, {
            left: box.left + Number(legacyClip[4]),
            top: box.top + Number(legacyClip[1]),
            right: box.left + Number(legacyClip[2]),
            bottom: box.top + Number(legacyClip[3]),
          });
        const inset = style.clipPath.match(/^inset\(([^)]+)\)$/);
        if (inset && !inset[1].includes("round")) {
          const parts = inset[1].trim().split(/\s+/);
          if (parts.every(part => /^-?[\d.]+(?:px|%)$/.test(part))) {
            const offsets = [
              parts[0],
              parts[1] ?? parts[0],
              parts[2] ?? parts[0],
              parts[3] ?? parts[1] ?? parts[0],
            ].map(
              (part, index) =>
                parseFloat(part) *
                (part.endsWith("%")
                  ? (index % 2 ? box.width : box.height) / 100
                  : 1)
            );
            rect = visibility.intersects(rect, {
              left: box.left + offsets[3],
              top: box.top + offsets[0],
              right: box.right - offsets[1],
              bottom: box.bottom - offsets[2],
            });
          }
        }
        if (
          /^circle\(0(?:px|%)(?:\s|\))/.test(style.clipPath) ||
          !visibility.present(rect)
        )
          return null;
      }
      return visibility.exposed(element, rect) ? rect : null;
    },
  };
  const rendered: {
    key: string;
    kind: "dom" | "raster";
    rect: Rect;
    paint: string;
  }[] = [];
  let textLength = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let textNode: Node | null;
  let inspected = 0;
  while ((textNode = walker.nextNode()) && inspected++ < 3000) {
    const parent = textNode.parentElement;
    if (
      !parent ||
      parent.closest("script,style,noscript,template") ||
      !textNode.textContent?.trim()
    )
      continue;
    const style = getComputedStyle(parent);
    if (!visibility.nontransparent(style.color) && style.textShadow === "none")
      continue;
    const range = document.createRange();
    range.selectNodeContents(textNode);
    let visible = false;
    Array.from(range.getClientRects()).forEach((original, fragment) => {
      const rect = visibility.rect(parent, original);
      if (!rect) return;
      visible = true;
      rendered.push({
        key: `text-${inspected}-${fragment}`,
        kind: "dom",
        rect,
        paint: JSON.stringify([
          textNode!.textContent!.trim(),
          style.color,
          style.font,
          style.letterSpacing,
          style.textTransform,
          style.textDecoration,
          style.textShadow,
          visibility.effects(parent),
        ]),
      });
    });
    if (visible) textLength += textNode.textContent.trim().length;
  }
  let canvases = 0,
    nodes = 0,
    painted = 0;
  const elements = Array.from(document.body.querySelectorAll("*")).slice(
    0,
    1500
  );
  for (const [index, element] of elements.entries()) {
    const rect = visibility.rect(element);
    if (!rect) continue;
    if (
      element instanceof HTMLCanvasElement &&
      element.width > 0 &&
      element.height > 0
    )
      canvases += 1;
    if (
      element.matches("button,svg") ||
      (element instanceof HTMLImageElement &&
        element.complete &&
        element.naturalWidth > 0)
    )
      nodes += 1;
    if (
      element.matches("canvas,svg,img") &&
      !element.parentElement?.closest("svg")
    ) {
      let pixels = "";
      if (element instanceof HTMLCanvasElement) {
        try {
          pixels = element.toDataURL();
        } catch {
          /* Screenshot still supplies evidence. */
        }
      }
      rendered.push({
        key: `raster-${index}`,
        kind: "raster",
        rect,
        paint: pixels,
      });
    }
    if (
      element.matches("script,style,noscript,template") ||
      element.closest("svg")
    )
      continue;
    const style = getComputedStyle(element);
    if (
      visibility.nontransparent(style.backgroundColor) ||
      style.backgroundImage !== "none" ||
      style.boxShadow !== "none" ||
      ["Top", "Right", "Bottom", "Left"].some(
        side =>
          parseFloat(
            style.getPropertyValue(`border-${side.toLowerCase()}-width`)
          ) > 0 &&
          !["none", "hidden"].includes(
            style.getPropertyValue(`border-${side.toLowerCase()}-style`)
          ) &&
          visibility.nontransparent(
            style.getPropertyValue(`border-${side.toLowerCase()}-color`)
          )
      )
    ) {
      painted += 1;
      rendered.push({
        key: `paint-${index}`,
        kind: "dom",
        rect,
        paint: JSON.stringify([
          style.backgroundColor,
          style.backgroundImage,
          style.backgroundPosition,
          style.backgroundSize,
          style.backgroundRepeat,
          style.backgroundClip,
          style.boxShadow,
          ...["top", "right", "bottom", "left"].flatMap(side => [
            style.getPropertyValue(`border-${side}-width`),
            style.getPropertyValue(`border-${side}-style`),
            style.getPropertyValue(`border-${side}-color`),
          ]),
          style.borderRadius,
          visibility.effects(element),
        ]),
      });
    }
  }
  const candidates = Array.from(
    document.querySelectorAll("canvas, [data-cell], [role=gridcell], button")
  );
  const target = candidates
    .map(element => visibility.rect(element))
    .find(rect => rect !== null);
  const startIndex = Array.from(
    document.querySelectorAll("button, [role=button]")
  ).findIndex(
    element =>
      /^(?:开始.*|start.*|play.*|进入.*)$/i.test(
        (element.getAttribute("aria-label") ?? element.textContent ?? "").trim()
      ) && visibility.rect(element)
  );
  return {
    canvas: canvases > 0,
    text: textLength,
    nodes,
    painted,
    rendered,
    scroll: JSON.stringify([
      scrollX,
      scrollY,
      ...elements.flatMap((element, index) =>
        element.scrollLeft || element.scrollTop
          ? [[index, element.scrollLeft, element.scrollTop]]
          : []
      ),
    ]),
    startIndex,
    target: target
      ? {
          x: (target.left + target.right) / 2,
          y: (target.top + target.bottom) / 2,
        }
      : { x: innerWidth / 2, y: innerHeight / 2 },
    overflow: document.documentElement.scrollWidth > innerWidth + 4,
  };
}
async function stateSignature(page: Page, frame: Frame) {
  // Preserve the iframe's input focus: blurring it can pause a real game.
  await page.mouse.move(-10, -10);
  const surface = await frame.evaluate(visibleInterface);
  const screenshot = await page.screenshot({ animations: "disabled" });
  const offset = await (await frame.frameElement()).boundingBox();
  const screen = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scroll: JSON.stringify([
      scrollX,
      scrollY,
      visualViewport?.offsetLeft,
      visualViewport?.offsetTop,
    ]),
  }));
  return {
    surface,
    screenshot,
    hash: digest(screenshot),
    screen,
    offset: { x: offset?.x ?? 0, y: offset?.y ?? 0 },
  };
}
type QaState = Awaited<ReturnType<typeof stateSignature>>;
async function visibleDifference(
  page: Page,
  actual: QaState,
  control: QaState
) {
  if (actual.hash === control.hash) return false;
  const reference = new Map(
    control.surface.rendered.map(entry => [entry.key, entry])
  );
  const current = new Map(
    actual.surface.rendered.map(entry => [entry.key, entry])
  );
  const regions: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }[] = [];
  for (const [state, other] of [
    [actual, reference],
    [control, current],
  ] as const) {
    for (const entry of state.surface.rendered) {
      const previous = other.get(entry.key);
      // DOM attributes and native focus chrome cannot nominate a changed region.
      // Canvas pixels nominate only when drawing changed; SVG/images are compared
      // directly because their visible rendering is not represented by DOM styles.
      if (
        previous &&
        entry.paint === previous.paint &&
        JSON.stringify(entry.rect) === JSON.stringify(previous.rect) &&
        !(entry.kind === "raster" && !entry.paint)
      )
        continue;
      regions.push({
        left: entry.rect.left + state.offset.x,
        top: entry.rect.top + state.offset.y,
        right: entry.rect.right + state.offset.x,
        bottom: entry.rect.bottom + state.offset.y,
      });
    }
  }
  if (!regions.length) return false;
  // Verify candidates against what the browser actually displayed. This rejects
  // a changed DOM style/text or canvas drawing behind an opaque overlay.
  return page.evaluate(
    async ({ first, second, regions, screen }) => {
      const firstImage = new Image(),
        secondImage = new Image();
      firstImage.src = first;
      secondImage.src = second;
      await Promise.all([firstImage.decode(), secondImage.decode()]);
      if (
        firstImage.width !== secondImage.width ||
        firstImage.height !== secondImage.height
      )
        return false;
      const canvas = document.createElement("canvas");
      canvas.width = firstImage.width;
      canvas.height = firstImage.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(firstImage, 0, 0);
      const a = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(secondImage, 0, 0);
      const b = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const scaleX = canvas.width / screen.width,
        scaleY = canvas.height / screen.height;
      for (const rect of regions) {
        const left = Math.max(0, Math.floor(rect.left * scaleX));
        const right = Math.min(canvas.width, Math.ceil(rect.right * scaleX));
        const top = Math.max(0, Math.floor(rect.top * scaleY));
        const bottom = Math.min(canvas.height, Math.ceil(rect.bottom * scaleY));
        for (let y = top; y < bottom; y++) {
          for (let x = left; x < right; x++) {
            const offset = (y * canvas.width + x) * 4;
            if (
              a[offset] !== b[offset] ||
              a[offset + 1] !== b[offset + 1] ||
              a[offset + 2] !== b[offset + 2] ||
              a[offset + 3] !== b[offset + 3]
            )
              return true;
          }
        }
      }
      return false;
    },
    {
      first: `data:image/png;base64,${actual.screenshot.toString("base64")}`,
      second: `data:image/png;base64,${control.screenshot.toString("base64")}`,
      regions,
      screen: actual.screen,
    }
  );
}
async function playPair(
  page: Page,
  control: Page,
  frame: Frame,
  touch: boolean
) {
  const { target } = await frame.evaluate(visibleInterface);
  if (touch) await page.touchscreen.tap(target.x, target.y);
  else await page.mouse.click(target.x, target.y);
  await Promise.all([wait(page, 120), wait(control, 120)]);
  for (const key of ["ArrowRight", "d", "Space", "ArrowLeft"]) {
    const duration = key === "ArrowLeft" ? 160 : 320;
    await page.keyboard.down(key);
    await Promise.all([wait(page, duration), wait(control, duration)]);
    await page.keyboard.up(key);
  }
  await Promise.all([wait(page, 160), wait(control, 160)]);
}
async function execute(message: {
  artifact: GameArtifact;
  hash: string;
  environment: ValidationReport["environment"];
  checks: ValidationCheck[];
}) {
  const path = executable();
  if (!path) {
    process.send?.({ unavailable: true });
    return;
  }
  const { artifact, hash, environment } = message;
  const checks = [...message.checks];
  const errors: string[] = [];
  const blocked = new Set<string>();
  const html = bundleGameArtifact(artifact).html;
  browser = await chromium.launch({
    executablePath: path,
    headless: true,
    chromiumSandbox: true,
    timeout: 10_000,
    args: [
      "--disable-background-networking",
      "--disable-extensions",
      "--mute-audio",
    ],
  });
  let evidence: ValidationReport["evidence"];
  for (const viewport of [environment.viewport, { width: 390, height: 844 }]) {
    for (const seed of [environment.seed, environment.seed + 1]) {
      const touch = viewport.width < 500;
      const contextOptions = {
        viewport,
        hasTouch: touch,
        isMobile: touch,
        acceptDownloads: false,
        serviceWorkers: "block" as const,
        permissions: [],
      };
      // Playwright clocks belong to a browser context. Sharing one context
      // advances/reinstalls the other's clock and invalidates RAF comparisons.
      const context = await browser.newContext(contextOptions);
      const controlContext = await browser.newContext(contextOptions);
      for (const isolated of [context, controlContext]) {
        await isolated.route("**/*", route => {
          const url = route.request().url();
          if (/^(?:data:|about:|blob:)/.test(url)) return route.continue();
          blocked.add(new URL(url).protocol);
          return route.abort();
        });
        isolated.on("page", page => {
          page.on("pageerror", error => {
            if (errors.length < 12) errors.push(error.message.slice(0, 500));
          });
          page.on("dialog", dialog => void dialog.dismiss());
        });
      }
      const page = await context.newPage();
      const control = await controlContext.newPage();
      page.setDefaultTimeout(2000);
      control.setDefaultTimeout(2000);
      const frame = await openGame(page, html, seed);
      const baseline = await openGame(control, html, seed);
      await startGame(frame);
      await startGame(baseline);
      await Promise.all([wait(page, 120), wait(control, 120)]);
      const suffix = `${viewport.width}px / seed ${seed}`;
      const surface = await frame.evaluate(visibleInterface);
      checks.push({
        id: `surface-${suffix}`,
        label: "可见游戏界面",
        scope: "runtime",
        status:
          surface.canvas || surface.text || surface.nodes || surface.painted
            ? "pass"
            : "fail",
        detail: suffix,
      });
      checks.push({
        id: `layout-${suffix}`,
        label: "屏幕适配",
        scope: "visual",
        status: surface.overflow ? "warn" : "pass",
        detail: `${suffix}${surface.overflow ? "：页面横向溢出，需人工检查触控与布局。" : "：未检测到横向溢出；美术与文字可读性需人工评估。"}`,
      });
      const before = await stateSignature(page, frame);
      const baselineBefore = await stateSignature(control, baseline);
      await playPair(page, control, frame, touch);
      const actualState = await stateSignature(page, frame);
      const controlState = await stateSignature(control, baseline);
      const deterministic = !(await visibleDifference(
        page,
        before,
        baselineBefore
      ));
      const scrolled =
        actualState.surface.scroll !== before.surface.scroll ||
        controlState.surface.scroll !== baselineBefore.surface.scroll ||
        actualState.screen.scroll !== before.screen.scroll ||
        controlState.screen.scroll !== baselineBefore.screen.scroll;
      const responsive =
        deterministic &&
        !scrolled &&
        (await visibleDifference(page, actualState, controlState));
      checks.push({
        id: `input-${suffix}`,
        label: "真实输入产生可见变化",
        scope: "input",
        status: responsive ? "pass" : "unverified",
        detail: responsive
          ? `${suffix}：同种子、同虚拟时钟下，可见游戏绘制区域的像素与无输入对照不同。DOM 需有实际文本/绘制样式/几何变化；不计原生焦点。仅证明操作引起可见变化。`
          : `${suffix}：${!deterministic ? "初始画面不一致，无法建立确定性对照" : scrolled ? "检测到页面滚动，无法排除浏览器默认输入行为" : "未观察到输入造成可见画面变化"}，需提供针对该玩法的操作测试。`,
      });
      if (!evidence)
        evidence = {
          screenshotDataUrl: `data:image/png;base64,${(await page.screenshot({ animations: "disabled" })).toString("base64")}`,
        };
      await context.close();
      await controlContext.close();
    }
  }
  checks.push({
    id: "errors",
    label: "运行时异常",
    scope: "runtime",
    status: errors.length ? "fail" : "pass",
    detail: errors.length
      ? errors.join("\n")
      : "四组桌面/手机与随机种子测试未捕获 JavaScript 异常。",
  });
  if (blocked.size)
    checks.push({
      id: "network",
      label: "网络隔离",
      scope: "build",
      status: "fail",
      detail: "游戏尝试访问离线包以外的资源；请求已阻止。",
    });
  const designFile = artifact.files.find(
    file => file.path === "arcane.design.json"
  );
  if (designFile) {
    try {
      const design = JSON.parse(designFile.content);
      for (const criterion of Array.isArray(design.acceptance)
        ? design.acceptance.slice(0, 40)
        : [])
        checks.push({
          id: `acceptance-${String(criterion.id)}`,
          label: "玩法要求待确认",
          scope: "acceptance",
          status: "warn",
          detail:
            String(criterion.requirement).slice(0, 1000) +
            "（本次未自动验证，需要创作者试玩确认。）",
        });
    } catch {
      checks.push({
        id: "design",
        label: "设计契约",
        scope: "build",
        status: "fail",
        detail: "arcane.design.json 无法解析。",
      });
    }
  }
  checks.push({
    id: "playability",
    label: "玩法完整性",
    scope: "acceptance",
    status: "warn",
    detail:
      "胜负、数值、重开和游戏趣味尚需针对性验收；本报告不证明全部用户规则成立。",
  });
  const report: ValidationReport = {
    schemaVersion: 1,
    artifactHash: hash,
    status: checks.some(check => check.status === "fail")
      ? "failed"
      : checks.some(check => check.status === "unverified")
        ? "unverified"
        : "passed",
    environment: { ...environment, browser: browser.version() },
    checks,
    errors,
    durationMs: 0,
    testedAt: new Date().toISOString(),
    evidence,
  };
  await browser.close();
  browser = undefined;
  process.send?.({ report });
}
process.on("disconnect", () => {
  if (browser) void browser.close().finally(() => process.exit(0));
  else process.exit(0);
});
process.once("message", message => {
  void execute(message as Parameters<typeof execute>[0]).catch(() =>
    process.send?.({ unavailable: true })
  );
});
