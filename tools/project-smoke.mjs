import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Only the browser UI is real. Model, authentication and persistence calls are
// controlled fixtures; this test never consumes a model API or a database.
const baseUrl = process.env.ARCANE_TEST_BASE_URL || "http://127.0.0.1:3090";
const executablePath =
  process.env.ARCANE_BROWSER_EXECUTABLE ||
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
const calls = [];
page.on("pageerror", error => errors.push(error.message));
const source = label =>
  `<!doctype html><html><head><title>项目流程验收</title></head><body><button>${label}</button><script>document.querySelector('button').onclick=e=>e.target.textContent='已点击'</script></body></html>`;
const artifactOf = (title, label) => ({
  title,
  description: "项目流程 fixture",
  controls: ["点击按钮"],
  files: [{ path: "index.html", content: source(label), language: "html" }],
});
const projects = [
  { id: 1, name: "A 项目" },
  { id: 2, name: "B 项目" },
];
const createdAt = new Date().toISOString();
const pendingBuild = {
  status: "pending",
  attempts: 1,
  repairApplied: false,
  logs: ["等待独立运行验证"],
};
const configuredArtifact = artifactOf("A 游戏", "A 原始");
configuredArtifact.files[0].content =
  configuredArtifact.files[0].content.replace(
    "</body>",
    `<output id="speed"></output><script>fetch('arcane.config.json').then(r=>r.json()).then(config=>document.querySelector('#speed').textContent='速度 '+config.parameters[0].value)</script></body>`
  );
configuredArtifact.files.push({
  path: "arcane.config.json",
  language: "json",
  content: JSON.stringify({
    schemaVersion: 1,
    parameters: [
      {
        id: "speed",
        label: "速度",
        type: "number",
        value: 3,
        min: 1,
        max: 10,
        step: 1,
      },
    ],
  }),
});
const versions = new Map([
  [
    1,
    [
      {
        id: 11,
        version: 1,
        projectId: 1,
        createdAt,
        artifact: configuredArtifact,
        build: pendingBuild,
      },
    ],
  ],
  [
    2,
    [
      {
        id: 21,
        version: 1,
        projectId: 2,
        createdAt,
        artifact: artifactOf("B 游戏", "B 原始"),
        build: pendingBuild,
      },
    ],
  ],
]);
let nextVersionId = 30,
  failNextSave = false,
  delayNextSave = false,
  releaseSave,
  releaseStream;
let publication = null;
const publishedId = "a02557f5-ab26-487b-8d42-0123456789ab";
const loaded = item =>
  item
    ? {
        artifact: item.artifact,
        files: item.artifact.files,
        build: item.build,
        version: { ...item, artifactHash: "fixture-hash", state: "validated" },
      }
    : null;
const success = data => ({ result: { data: { json: data } } });
const failure = (message, path) => ({
  error: {
    json: {
      message,
      code: -32603,
      data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path },
    },
  },
});
await context.route("**/*", route => {
  if (new URL(route.request().url()).origin !== new URL(baseUrl).origin)
    return route.abort();
  return route.continue();
});
await context.route("**/api/trpc/**", async route => {
  const url = new URL(route.request().url());
  const procedures = url.pathname.split("/api/trpc/")[1].split(",");
  const raw =
    route.request().method() === "GET"
      ? JSON.parse(url.searchParams.get("input") || "{}")
      : route.request().postDataJSON();
  const results = [];
  for (let index = 0; index < procedures.length; index++) {
    const procedure = procedures[index],
      input = raw?.[index]?.json;
    calls.push({ procedure, input });
    if (procedure === "auth.me")
      results.push(
        success({
          id: 1,
          name: "Smoke Creator",
          openId: "fixture-user",
          role: "user",
          email: "fixture@example.invalid",
          loginMethod: "fixture",
          createdAt,
          updatedAt: createdAt,
          lastSignedIn: createdAt,
        })
      );
    else if (procedure === "game.listProjects") results.push(success(projects));
    else if (procedure === "game.latestVersion")
      results.push(success(loaded(versions.get(input.projectId)?.at(-1))));
    else if (procedure === "game.versions")
      results.push(
        success({
          items: [...(versions.get(input.projectId) || [])]
            .reverse()
            .map(({ artifact, build, ...version }) => version),
          nextCursor: null,
        })
      );
    else if (procedure === "game.loadVersion")
      results.push(
        success(
          loaded(
            versions
              .get(input.projectId)
              ?.find(item => item.id === input.versionId)
          )
        )
      );
    else if (procedure === "game.saveVersion") {
      if (delayNextSave) {
        delayNextSave = false;
        await new Promise(resolve => {
          releaseSave = resolve;
        });
      }
      if (failNextSave) {
        failNextSave = false;
        results.push(failure("模拟保存失败，本地草稿应保留", procedure));
      } else {
        const previous = versions.get(input.projectId) || [];
        const saved = {
          id: ++nextVersionId,
          version: previous.length + 1,
          projectId: input.projectId,
          createdAt,
          artifact: input.artifact,
          build: input.build,
        };
        versions.set(input.projectId, [...previous, saved]);
        results.push(
          success({
            projectVersionId: saved.id,
            version: saved.version,
            manifest: {},
          })
        );
      }
    } else if (procedure === "game.validateArtifact")
      results.push(
        success({
          receipt: "fixture-browser-receipt",
          report: {
            schemaVersion: 1,
            artifactHash: "fixture-hash",
            status: "passed",
            environment: {
              runner: "playwright",
              browser: "fixture",
              viewport: { width: 800, height: 600 },
              seed: 1,
            },
            checks: [
              {
                id: "input",
                label: "操作检查",
                scope: "input",
                status: "pass",
                detail: "fixture 操作通过",
              },
              {
                id: "manual",
                label: "玩法验收",
                scope: "acceptance",
                status: "warn",
                detail: "需要创作者亲自确认",
              },
            ],
            errors: [],
            durationMs: 1,
            testedAt: createdAt,
          },
        })
      );
    else if (procedure === "game.publishVersion") {
      assert.equal(input.confirmedGameplay, true);
      assert.equal(input.validationReceipt, "fixture-browser-receipt");
      const version = [...versions.values()]
        .flat()
        .find(item => item.id === input.projectVersionId);
      assert.ok(version);
      publication = { version, visibility: input.visibility };
      results.push(
        success({
          publicationId: publishedId,
          visibility: input.visibility,
          url: `/play/${publishedId}`,
        })
      );
    } else if (procedure === "game.publishedVersion")
      results.push(
        publication
          ? success({
              publication: {
                id: publishedId,
                visibility: publication.visibility,
                confirmedGameplay: true,
                createdAt,
              },
              artifact: publication.version.artifact,
              files: publication.version.artifact.files,
              version: {
                ...publication.version,
                artifactHash: "fixture-hash",
                state: "validated",
              },
            })
          : failure("作品已撤销", procedure)
      );
    else if (procedure === "game.explore")
      results.push(
        success({
          items:
            publication?.visibility === "public"
              ? [
                  {
                    publicationId: publishedId,
                    title: publication.version.artifact.title,
                    description: publication.version.artifact.description,
                    version: publication.version.version,
                    createdAt,
                  },
                ]
              : [],
          nextCursor: null,
        })
      );
    else if (procedure === "game.remix") {
      assert.ok(publication);
      const project = { id: 3, name: "A Remix" };
      projects.push(project);
      const version = {
        ...publication.version,
        id: ++nextVersionId,
        projectId: project.id,
        version: 1,
      };
      versions.set(project.id, [version]);
      results.push(
        success({ project, version, sourcePublicationId: publishedId })
      );
    } else if (procedure === "game.revokePublication") {
      publication = null;
      results.push(success({ success: true }));
    } else results.push(success(null));
  }
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(results),
  });
});
await context.route("**/api/game/stream", async route => {
  const input = route.request().postDataJSON();
  if (input.prompt.includes("慢任务"))
    await new Promise(resolve => {
      releaseStream = resolve;
    });
  const result = {
    artifact: artifactOf("旧 A 任务", "旧结果"),
    build: pendingBuild,
    trace: [],
    assistantMessage: "旧任务完成",
    runId: input.runId,
  };
  await route
    .fulfill({
      contentType: "text/event-stream",
      body: `event: complete\ndata: ${JSON.stringify(result)}\n\n`,
    })
    .catch(() => {});
});
const preview = () => page.frameLocator('iframe[title="游戏隔离预览"]');
async function waitGame(label) {
  await preview().getByRole("button", { name: label, exact: true }).waitFor();
}
async function switchProject(name) {
  await page.locator(".project-current").click();
  await page
    .locator(".project-popover")
    .getByRole("button", { name, exact: true })
    .click();
}
async function editGame(label) {
  await page
    .locator(".monaco-editor textarea")
    .first()
    .waitFor({ timeout: 30_000 });
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(source(label));
  await waitGame(label);
}
async function saveGame() {
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await page
    .getByRole("button", { name: "Save version", exact: true })
    .waitFor();
}
try {
  await page.goto(`${baseUrl}/?project=1`);
  await waitGame("A 原始");
  await page.getByRole("button", { name: "参数", exact: true }).click();
  await page.getByRole("spinbutton").fill("7");
  await preview().getByText("速度 7", { exact: true }).waitFor();
  await page.getByRole("spinbutton").fill("99");
  await preview().getByText("速度 10", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("spinbutton").inputValue(),
    "10",
    "参数值必须限制在声明的范围"
  );
  await page.getByRole("button", { name: /^Files/ }).click();
  await editGame("A 未保存");
  await switchProject("B 项目");
  await waitGame("B 原始");
  await switchProject("A 项目");
  await waitGame("A 未保存");
  failNextSave = true;
  await saveGame();
  await page
    .getByText("模拟保存失败，本地草稿应保留", { exact: true })
    .first()
    .waitFor();
  assert.equal(versions.get(1).length, 1);
  assert.match(await page.locator(".editor-head").innerText(), /未保存/);
  await saveGame();
  await page.getByText("版本 v2 已保存", { exact: true }).first().waitFor();
  assert.match(versions.get(1).at(-1).artifact.files[0].content, /A 未保存/);
  assert.doesNotMatch(await page.locator(".editor-head").innerText(), /未保存/);

  await page.locator(".composer textarea").fill("慢任务修改 A");
  await page.getByRole("button", { name: "应用修改", exact: true }).click();
  await page.getByRole("button", { name: "停止", exact: true }).waitFor();
  await switchProject("B 项目");
  await waitGame("B 原始");
  releaseStream?.();
  await page.waitForTimeout(300);
  assert.equal(
    await page.getByRole("heading", { name: "旧 A 任务", exact: true }).count(),
    0
  );
  await switchProject("A 项目");
  await waitGame("A 未保存");

  await editGame("A 延迟保存");
  delayNextSave = true;
  await page.getByRole("button", { name: "Save version", exact: true }).click();
  await page.getByRole("button", { name: "保存中…", exact: true }).waitFor();
  await switchProject("B 项目");
  await waitGame("B 原始");
  releaseSave?.();
  await page
    .getByRole("button", { name: "Save version", exact: true })
    .waitFor();
  await waitGame("B 原始");
  await switchProject("A 项目");
  await waitGame("A 延迟保存");

  await editGame("A 恢复前的脏稿");
  await page.getByRole("button", { name: "历史", exact: true }).click();
  const originalVersion = page
    .locator(".version-entry")
    .filter({ has: page.getByText("v1", { exact: true }) });
  await originalVersion
    .getByRole("button", { name: "预览", exact: true })
    .click();
  await waitGame("A 原始");
  assert.equal(
    await page
      .getByRole("button", { name: "Save version", exact: true })
      .isDisabled(),
    true
  );
  await page.getByRole("button", { name: "返回当前草稿", exact: true }).click();
  await waitGame("A 恢复前的脏稿");
  const savedVersionsBeforeRestore = versions.get(1).length;
  failNextSave = true;
  await originalVersion
    .getByRole("button", { name: "恢复为新版本", exact: true })
    .click();
  await page
    .getByText("模拟保存失败，本地草稿应保留", { exact: true })
    .first()
    .waitFor();
  await waitGame("A 恢复前的脏稿");
  assert.equal(
    versions.get(1).length,
    savedVersionsBeforeRestore,
    "恢复保存失败不能覆盖当前草稿"
  );
  await page.getByRole("button", { name: "关闭历史", exact: true }).click();

  await editGame("A 发布版本");
  await page.getByRole("button", { name: "发布", exact: true }).click();
  const publishButton = page.getByRole("button", {
    name: "保存并发布",
    exact: true,
  });
  assert.equal(await publishButton.isDisabled(), true);
  await page.getByRole("button", { name: "验证当前游戏", exact: true }).click();
  await page.locator(".verification-verdict.passed").waitFor();
  assert.equal(
    await publishButton.isDisabled(),
    true,
    "真实运行报告之外仍需创作者确认"
  );
  await page.getByRole("checkbox").check();
  await page
    .getByRole("combobox", { name: "发布可见范围" })
    .selectOption("public");
  failNextSave = true;
  await publishButton.click();
  await page
    .getByText("模拟保存失败，本地草稿应保留", { exact: true })
    .first()
    .waitFor();
  assert.equal(publication, null, "保存失败不得发布");
  await publishButton.click();
  await page.locator(".published-entry").waitFor();
  assert.match(publication.version.artifact.files[0].content, /A 发布版本/);
  await mkdir("docs/implementation-2026-10-10", { recursive: true });
  await page.screenshot({
    path: "docs/implementation-2026-10-10/project-publish.png",
    fullPage: true,
  });

  await page.goto(`${baseUrl}/explore`);
  await page.getByRole("heading", { name: "A 游戏", exact: true }).waitFor();
  await page.locator(".community-game-card").click();
  await page
    .frameLocator('iframe[title="A 游戏 试玩"]')
    .getByRole("button", { name: "A 发布版本", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Remix", exact: true }).click();
  await page.waitForURL("**/?project=3");
  await waitGame("A 发布版本");
  assert.match(await page.locator(".project-current").innerText(), /A Remix/);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "手机预览", exact: true }).click();
  await page.waitForTimeout(500);
  await waitGame("A 发布版本");
  const titleBox = await page.locator(".preview-top").boundingBox();
  const frameBox = await page.locator(".preview-frame-wrap").boundingBox();
  const controlsBox = await page.locator(".controls-strip").boundingBox();
  assert.ok(
    frameBox.y >= titleBox.y + titleBox.height,
    "手机iframe不能覆盖标题"
  );
  assert.ok(
    controlsBox.y >= frameBox.y + frameBox.height,
    "手机controls不能覆盖iframe"
  );
  await page.screenshot({
    path: "docs/implementation-2026-10-10/project-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "发布", exact: true }).click();
  await page.getByRole("button", { name: "撤销发布", exact: true }).click();
  await page.locator(".published-entry").waitFor({ state: "hidden" });
  await page.goto(`${baseUrl}/play/${publishedId}`);
  await page
    .getByRole("heading", { name: "暂时无法打开这个游戏", exact: true })
    .waitFor();
  assert.deepEqual(errors, [], "项目工作流不得出现未捕获浏览器错误");
  await writeFile(
    "docs/implementation-2026-10-10/project-flow-smoke.json",
    JSON.stringify(
      {
        status: "passed",
        mode: "mock model/API + real browser",
        testedAt: new Date().toISOString(),
        checks: [
          "A/B dirty draft isolation",
          "config parameters affect actual preview and enforce range",
          "history preview and failed restore preserve dirty draft",
          "failed save preservation",
          "delayed save/project isolation",
          "stale generation rejection",
          "publish requires receipt and manual confirmation",
          "save failure blocks publication",
          "Explore/Play/Remix",
          "mobile preview layout",
          "revoke removes access",
        ],
        apiCalls: calls.length,
      },
      null,
      2
    )
  );
  console.log(
    "Project browser smoke passed: project isolation/save failure/delayed save/stale task/publish/Explore/Play/Remix/revoke/mobile."
  );
} finally {
  releaseSave?.();
  releaseStream?.();
  await browser.close();
}
