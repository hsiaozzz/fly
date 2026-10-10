# 贡献说明

ARCANE 的主分支保存可复现的项目实现。先阅读 [README](README.md) 和 [路线图](docs/ROADMAP.md)，从独立分支提交 Pull Request。

## 开发和验证

使用 Node.js 22.12+、pnpm 10.4.1，运行 `pnpm install --frozen-lockfile`。配置文件只保存在本机，新增配置项同时更新 `.env.example`。

提交前执行 `pnpm check`、`pnpm test`、`pnpm check:process-cleanup` 和 `pnpm build`。涉及工作台或游戏运行时的改动，还要运行 `node tools/browser-smoke-suite.mjs` 与 `pnpm check:production`；浏览器路径通过 `ARCANE_BROWSER_EXECUTABLE` 配置。进程清理用例在 POSIX 环境运行，CI 使用 Linux 执行。

测试默认不调用付费模型。真实 MySQL 用例只使用显式 `ARCANE_TEST_DATABASE_URL` 指定的一次性测试库，先执行 migrations。不要配置业务数据库。CI 会创建临时 MySQL 8、执行所有迁移和真实浏览器回归。

## 实现约定

- 游戏源代码、编辑、预览、导出和保存使用同一 artifact 快照；验证结果必须绑定其 SHA-256。
- 生成调用受共享任务预算与取消信号约束；任何额外模型调用必须纳入同一账本。
- 游戏代码属于不可信输入，保留 iframe、离线 CSP、worker 与权限边界。浏览器通过只说明已检查的工程和输入行为。
- Schema 改动生成新的 migration，先检查 SQL，不修改已经应用的历史 migration。为关键事务、权限或竞态增加行为回归。
- 不提交 `.env`、密钥、模型输出、业务数据、日志、`node_modules` 和 `dist`。依赖变更同时更新 lockfile。

PR 说明写清具体触发条件、改后行为、验证结果和未覆盖的边界。现有审查记录描述当时快照，不应当作当前源码的逐行 diff。
