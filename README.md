# ARCANE

[![Verify ARCANE](https://github.com/hsiaozzz/fly/actions/workflows/ci.yml/badge.svg)](https://github.com/hsiaozzz/fly/actions/workflows/ci.yml)

自然语言创作、可编辑源码、可验证试玩、版本发布与再创作。项目仓库：[hsiaozzz/fly](https://github.com/hsiaozzz/fly)。

ARCANE 将自然语言游戏设计转换为可编辑、可预览的 HTML5 项目，支持版本历史、真实浏览器工程验证和固定版本发布。模型生成成功、浏览器通过、创作者确认玩法是三种不同结论；发布要求后两项同时满足。

## 本地开发

使用 Node.js 22.12+ 和 pnpm 10.4.1。本地试玩无需在线服务配置：启动工作台后点击「体验示例」，即可运行手工预置的接苹果游戏、修改源码和导出 ZIP。示例不调用模型，也不代表 AI 生成质量。默认品牌 SVG 随项目提供，不需要对象存储。

```sh
git clone https://github.com/hsiaozzz/fly.git
cd fly
pnpm install --frozen-lockfile
pnpm dev
```

需要真实 AI 创作、登录和云端项目时，再复制 `.env.example` 为 `.env`，填写独立开发环境的数据库、OAuth 和模型/对象存储配置，并执行 `pnpm db:migrate`。配置缺失时，工作台会标出尚未开启的功能。

MySQL 使用已提交的 migration。新增 schema 时在开发环境执行 `pnpm db:generate`，审阅生成的 SQL 后再运行 `pnpm db:migrate`。`db:push` 仅保留为 migrate 的兼容别名。生产 migration 前先备份，先在临时空库和现有库副本验证。已恢复缺失的初始 users migration；本次工作没有连接实际业务数据库，CI 已配置临时 MySQL 8.0 服务执行真实迁移和集成验证，实际 CI 结果见上方工作流；本地默认不会连接数据库。

## 校验与构建

```sh
pnpm check
pnpm test
pnpm check:process-cleanup
pnpm build
pnpm check:production
pnpm qa:example
pnpm start
```

测试默认全部使用 mock/本地数据，不调用真实 LLM、OAuth、对象存储。数据库集成用例默认跳过，只有显式 `ARCANE_TEST_DATABASE_URL` 才连接一次性测试库，并使用内存对象存储；不要把生产 URL 配到这个变量。CI 执行空库迁移、单元/集成测试、生产构建、编译后的浏览器 QA 和真实网页回归，并保存验证产物。`pnpm build` 分离开发 Vite chunk，生产入口不加载 Vite 或开发插件。`pnpm check:production` 创建不含 `.env` 或业务凭据的临时副本，沿用仓库的 registry／超时 `.npmrc`，仅安装生产依赖，检查服务导入、HTTP health 和编译后的浏览器 QA；需要先执行 `pnpm build` 并安装 Chromium 或设置 `ARCANE_BROWSER_EXECUTABLE`。它验证依赖和基础行为，不替代真实配置下的生产启动。dev/start 脚本兼容 Windows 与 POSIX shell。

服务固定使用 `PORT`；端口占用会失败退出。生产缺少必需配置、签名 secret 少于 32 字符、数据库不可用或 migration 缺失时拒绝启动。`GET /api/health` 检查进程存活；`GET /api/ready` 检查数据库和必要 schema，并在关闭期间返回 503，同时分别返回正在生成与验证的数量。SIGTERM/SIGINT 停止接收新的生成与浏览器验证请求，最多排空 10 秒后关闭连接与数据库池。代理部署时设置准确的 `TRUST_PROXY_HOPS` 和 SSE 超时，生产使用 HTTPS。

`GET /api/capabilities` 仅检查本地配置和浏览器路径，不连接模型、OAuth、数据库或对象存储，也不返回地址、密钥或环境变量值。配置存在不代表服务连通；实际连通性仍未验证。工作台据此提示未开启的功能：AI 创作、登录和云项目分别判断；查询失败或返回旧格式时暂停在线入口，已有本地草稿仍可编辑、试玩和下载。

## 生成与资源控制

SSE 和 tRPC 共享匿名/IP、用户和全局配额及并发限额。默认匿名每天 3 次、单任务；登录用户每天 30 次、2 个并行任务；全局最多 4 个并行、每天 200 次，并预留每次 64000 tokens。规划、生成、JSON 重试和修复共享任务账本；每次请求先按输入 UTF-8 大小、消息开销和最大输出保守预留，额度不足时在调用模型前停止。生成关闭底层 POST 自动重试，避免未登记的重复付费调用。供应商提供 usage 时记录实际值，缺失 usage 或请求失败时按保守上界记账；失败任务不退还全局预留。客户端断线/取消和服务器 deadline 传递到模型调用。上传/请求总量也有上限。

这些计数器是**单进程内存限额**，重启会重置，多副本不共享；目前不是可收费的持久计费账本。增加副本或上线付费前，需要 Redis/数据库原子计数、持久成本账本和支付闭环；不能把内存安全上限当成准确费用。配置变量见 `.env.example`，每日窗口为 UTC 00:00。

浏览器验证使用独立的 `VALIDATION_*` 配额：默认每位登录用户每天 60 次、同时 1 个任务；全局每天 400 次、最多同时 2 个任务（可通过配置降低）。验证不调用模型，不占生成次数或预留模型 tokens。失败或取消的验证计入当天验证次数，任务结束释放并发名额；这些验证限额同样是单进程内存计数。

## 项目版本与私有对象

保存先校验安全路径、文件数与 UTF-8 总字节数、计算整个 artifact 的 SHA-256。对象上传前登记 `storage_cleanup`，上传完成后在一个数据库事务中锁定父项目、分配版本序号、校验 `baseVersionId`，写入文件/构建/对话/版本并清除登记。历史只显示完整 ready 快照，列表只返回分页元数据。`requestId` 为重试幂等键，同一键改变内容会冲突。

失败或崩溃留下的对象保持私有。`/manus-storage/*` 根据数据库关联校验项目所有权，不依据目录名或随机 URL 认定权限。公开品牌资源必须进入 `PUBLIC_STORAGE_KEYS` 的精确 key 列表；若 VITE_APP_LOGO 为存储路径，该单个对象视为公开。

对象存储删除 API 依赖实际部署。`STORAGE_DELETE_URL` 可连接一个 HTTPS 服务，接受 `POST {"path":"object-key"}`，使用服务端 Forge bearer 凭据；不要使用不可信服务。删除适配器未配置/失败时，记录保留在 `storage_cleanup`。配置后执行：

```sh
pnpm cleanup:storage
```

该任务每次处理最多 20 个登记超过一小时的对象，避免清理仍在运行的上传；任务不是自动部署的定时器。应在部署平台安排定时执行并监控队列积压。对象存储的生命周期保留规则可补充兜底。现有项目对象及已提交快照不会进入清理队列。

## 验证、分享与发布

`game.validateArtifact` 在独立进程中进行 Playwright 浏览器工程检查；使用 `ARCANE_BROWSER_EXECUTABLE` 指定已安装的受支持浏览器。检查失败或浏览器不可用会明确返回 failed/unverified。只有 passed 才生成短期、绑定精确 artifact hash 的签名 receipt，截图不放入 token。改动任意源文件或元数据都使 receipt 对该新快照无效。

发布固定的已保存版本，要求 receipt 和 `confirmedGameplay=true`。发布支持 private/unlisted/public；unlisted 使用可撤销随机分享 token，public 才进入 Explore。撤销 publication 不删除草稿或历史版本。remix 从允许访问的发布快照创建新项目，在 `projects.sourcePublicationId` 中持久保留来源（修改描述、撤销或删除源 publication 后仍保留），并修改派生快照标题与哈希、重新要求验证；不会暴露其他版本。浏览器工程通过不代表玩法质量自动验收，玩法确认来自创作者。

QA worker 隔离子进程、只传白名单环境、禁止网络/下载并设置超时。进程隔离与浏览器路由拦截**不能代替生产 OS 沙箱**；面对公开不可信用户，应将验证 worker 部署为独立低权限容器/用户，启用浏览器沙箱、系统级网络出口限制、内存/CPU配额和只读文件系统，禁用业务凭据，并把公共游戏放到独立无凭据域名。不要给 QA worker 或游戏运行域名业务数据库/云密钥。

本次实施没有部署公网服务、执行业务库 migration 或写入外部存储。在用户授权的 100,000 tokens 上限内尝试了 3 项真实模型评测，均返回 HTTP 401，没有生成成功或质量成绩；详见 [本地试玩与真实模型联调](docs/local-preview-2026-10-10/README.md)。新增浅色创作工作台与支付宝 Vibe Pay 基础网页收款，用户可购买创作额度／套餐；商户配置缺失时关闭售卖，付款由服务端验签后入账。设计来源、额度规则、配置和联调边界见 [界面与支付接入](docs/ui-payments-2026-10-10/README.md)。真正上线前，需要在配置好的 staging 完成 OAuth、对象签名/删除、真实浏览器、商户支付和升级 migration 的实际联调。

## 仓库导航

| 目录 | 内容 |
| --- | --- |
| `client/` | React 工作台、编辑预览、历史、参数、发布与探索 |
| `server/` | tRPC/SSE、生成与修复、权限、版本事务与浏览器 QA |
| `shared/game/` | 游戏快照、离线打包、设计契约、运行工具与参数规范 |
| `drizzle/` | MySQL schema 与按顺序执行的迁移 |
| `evals/` | 30 项中文创作请求、评测工具说明 |
| `tools/` | 开发启动、构建验收、浏览器回归和存储清理 |
| `docs/` | 原始代码审查、竞品依据及阶段交付记录 |

[贡献说明](CONTRIBUTING.md) · [仓库验证](docs/repository-2026-10-10/README.md) · [路线图](docs/ROADMAP.md) · [安全说明](SECURITY.md) · [第一轮交付](docs/implementation-2026-10-10/ARCANE-第一轮优化交付.md)

仓库沿用原 `fly` 项目的 [Apache License 2.0](LICENSE)。第三方依赖保留各自许可证。仓库不包含运行凭据、依赖目录、临时游戏产物或本机恢复归档。
