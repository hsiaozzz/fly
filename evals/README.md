# ARCANE 固定游戏评测

`game-prompts.json` 包含 30 个中文请求、明确验收要求、桌面/手机视口和随机种子。它是待执行的基准，不是已经达到的生成质量成绩。

默认只评测现有产物，不调用模型：把完整 GameArtifact 放在 `evals/artifacts/<id>.json`，运行 `pnpm eval:games --artifacts evals/artifacts --out evals/results`。浏览器对两个视口、两个种子执行构建、运行异常和真实按键/触控与无输入对照。需安装 Chromium 或设置 `ARCANE_BROWSER_EXECUTABLE`。

每项玩法验收尚需针对性 scenario 或人工试玩。如果人工完成，可写 `<id>.acceptance.json`，键为 `requiredAcceptance` 原文，值为 boolean。只有工程通过且全部已记录玩法要求为 true 才计入 qualified；没有玩法证据显示 null，不以运行通过推断规则正确。

实模型生成必须主动启用并指定预算：

```sh
pnpm eval:games --generate --allow-model-spend --max-tokens 100000 --limit 3
```

生成只对缺失文件执行，已有产物会直接复用；已有文件的 JSON/结构损坏或读取错误会记录失败，不会自动触发付费重建。每个生成任务的 tokenBudget 为评测总预算剩余额度与服务端 GENERATION_TOKEN_RESERVE 的较小值，服务端有效默认额度为 64000。规划、生成、JSON 重试和修复共享该任务预算，每次请求发送前检查「输入 UTF-8 字节上界 + 输出上限 + 协议开销」是否能容纳；例如只剩 5000 tokens 时，不会发送输出上限为 8000 的生成请求。底层网络请求不会自动重发，避免上游已经计费但本地未收到响应时重复付费。

产物和报告保存后可恢复。summary.json 的 tokensCharged 记录供应商有效 usage；缺失 usage 或请求失败时按该请求的保守上界计入，单项记录也保留其 charge。旧字段 tokensReported 仅作兼容，值与 tokensCharged 相同，不能当作精确供应商用量或账单。usage 回调只累计，不会在响应完成后抛异常丢弃已生成产物。正式大规模跑分仍需价格/账单核对与持久预算服务。缺文件、模型异常或浏览器不可用会记录错误，不填造成功率。

`pnpm qa:smoke` 是不调用模型的浏览器基础能力测试，覆盖多文件/module/CSS/SVG/JSON、正常输入、无输入自动动画、静态按钮焦点、语法错误和启动异常。`pnpm qa:workspace` 需要在 3090 端口运行开发网页，拦截模型/API以验证工作台编辑、ZIP一致性、草稿恢复、取消与伪造message。它不等同真实OAuth、MySQL或计费模型联调。
