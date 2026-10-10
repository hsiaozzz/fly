# ARCANE 固定游戏评测

`game-prompts.json` 包含 30 个中文请求、明确验收要求、桌面/手机视口和随机种子。它是待执行的基准，不是已经达到的生成质量成绩。

默认只评测现有产物，不调用模型：把完整 GameArtifact 放在 `evals/artifacts/<id>.json`，运行 `pnpm eval:games --artifacts evals/artifacts --out evals/results`。浏览器对两个视口、两个种子执行构建、运行异常和真实按键/触控与无输入对照。需安装 Chromium 或设置 `ARCANE_BROWSER_EXECUTABLE`。

每项玩法验收尚需针对性 scenario 或人工试玩。工程报告只验证构建、运行与输入反应，不能证明接到 10 个获胜等完整玩法要求。`qualifiedGames` 当前表示工程通过且完整人工声明逐项通过，`qualificationBasis` 明确为 `engineering-and-manual-claim`；人工声明不是自动玩法证明，也没有防止本地文件被人为伪造的签名机制。

先为已有有效产物准备未填写的人工验收模板（不调用模型或浏览器）：

```sh
pnpm eval:games --prepare-acceptance --artifacts evals/artifacts --out evals/acceptance-preparation
```

模板会绑定样本 id、完整产物 SHA-256，以及 `prompt`、`requiredAcceptance`、`seeds`、`viewports` 的契约 SHA-256。标题、说明、操作与任何源码文件变化都会改变产物摘要。这个命令只用排他创建写入缺失的 `<id>.acceptance.json`，不会覆盖任何既有文件，也不会设置任何 `passed: true`。不能同时传 `--generate`、`--allow-model-spend` 或非零 token 预算。字段格式如下（摘要以生成模板中的值为准）：

```json
{
  "schemaVersion": 1,
  "sampleId": "catch-apples",
  "sampleContractHash": "<模板中的64位SHA-256>",
  "artifactHash": "<模板中的64位SHA-256>",
  "method": "manual",
  "reviewer": null,
  "reviewedAt": null,
  "checks": [
    { "requirement": "苹果出现", "passed": null, "observation": null }
  ]
}
```

实际模板包含当前样本的全部验收要求。试玩后填写非空试玩人、带时区的 ISO 时间（如 `2026-10-10T12:00:00.000Z`），以及每项严格 boolean 的 `passed` 和非空观察记录；不能使用字符串 `"true"`、省略要求、增加要求或重复要求。`acceptanceStatus` 为 `missing`、`legacy`、`stale`、`invalid`、`incomplete` 时，`requirementsPassed` 与 `qualified` 保持 null。完整记录有任一 false 则 requirementsPassed 为 false。仅完整记录全部 true 且工程 passed 才计入 qualified；工程 unverified 时 qualified 仍为 null。产物或契约摘要不同的旧记录必须重新试玩，旧版 boolean 键值映射不自动迁移。

数据集采用严格 schemaVersion 1：1–30 个安全且不重复的 id（忽略大小写，禁止路径与系统保留文件名）、非空 prompt、非空且不重复的验收要求。评测在任何目录创建、模型或浏览器调用前验证整个数据集，包括 `--limit` 之外的案例。当前 runner 支持两个连续的 uint32 种子（第一个不超过 4294967294），第一个指定视口和固定第二视口 390×844，共四组；其他种子组合、重复视口或不同第二视口会显式拒绝。首个种子与视口传给 runner，不会静默忽略数据集设置。可用 `--dataset <文件>` 指定兼容数据集。

实模型生成必须主动启用并指定预算：

```sh
pnpm eval:games --generate --allow-model-spend --max-tokens 100000 --limit 3
```

生成只对缺失文件执行，已有产物会直接复用；已有文件的 JSON/结构损坏或读取错误会记录失败，不会自动触发付费重建。每个生成任务的 tokenBudget 为评测总预算剩余额度与服务端 GENERATION_TOKEN_RESERVE 的较小值，服务端有效默认额度为 64000。规划、生成、JSON 重试和修复共享该任务预算，每次请求发送前检查「输入 UTF-8 字节上界 + 输出上限 + 协议开销」是否能容纳；例如只剩 5000 tokens 时，不会发送输出上限为 8000 的生成请求。底层网络请求不会自动重发，避免上游已经计费但本地未收到响应时重复付费。

已保存产物可以离线复测。summary.json 的 tokensCharged 记录供应商有效 usage；缺失 usage 或请求失败时按该请求的保守上界计入，单项记录也保留其 charge。旧字段 tokensReported 仅作兼容，值与 tokensCharged 相同，不能当作精确供应商用量或账单。usage 回调只累计，不会在响应完成后抛异常丢弃已生成产物。summary 的 `budgetScope: "invocation"` 表示预算只约束本次进程运行，尚无跨重跑、崩溃恢复的持久计费账本；重新执行会重置预算并覆盖同一输出目录的 summary。发生模型错误、写盘错误或中止后，保留原 summary 与调用记录，不在原目录再次带 `--generate` 重试付费；仅对已保存产物做离线 QA，并使用新输出目录保存报告。正式可恢复付费批评测需先增加持久 checkpoint、排他锁与调用前预算预占，并核对供应商价格/账单。

缺文件、模型异常或浏览器不可用会记录错误，不填造成功率。summary 错误仅保留固定 `errorCategory` 与安全短说明；可信固定格式的 HTTP 状态可保留为 `errorHttpStatus`，超时/取消可保留有限 `errorKind`，不复制原始供应商响应、credential 或主机路径。完整浏览器报告与产物另行保存，不能把其中游戏代码输出当作受控 summary 的诊断字段。

`pnpm qa:smoke` 是不调用模型的浏览器基础能力测试，覆盖多文件/module/CSS/SVG/JSON、正常输入、无输入自动动画、静态按钮焦点、语法错误和启动异常。`pnpm qa:workspace` 需要在 3090 端口运行开发网页，拦截模型/API以验证工作台编辑、ZIP一致性、草稿恢复、取消与伪造message。它不等同真实OAuth、MySQL或计费模型联调。
