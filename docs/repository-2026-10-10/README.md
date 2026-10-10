# GitHub 项目仓库与可复现验证

2026-10-10。`hsiaozzz/fly` 作为 ARCANE 项目仓库，保留原仓库初始提交及 Apache 2.0 许可证，以普通合并接入已有本地实现。原 `codex/yt-dlp` 分支不修改。

## 本轮改动

- 仓库首页、描述、主题、package 名称与 repository 信息改为 ARCANE；补贡献、安全说明与分阶段路线图。
- 移除原模板的 Manus runtime、源码定位插件和开发请求 collector，保留 React／Tailwind 构建。开发默认监听本机地址；生产页面不再包含模板运行注入。
- 文档链接改为仓库相对路径；运行凭据、个人配置、恢复归档、依赖和生成输出不发布。
- 增加实际 migration 执行计划、schema 缺字段 readiness、迁移 journal 与重复迁移的回归。
- 网页测试等待慢请求真正到达及草稿实际存储，使用独立随机预览端口并有界清理；浏览器路径支持 Linux、Windows 与已安装 Playwright Chromium。
- `pnpm check:production` 在独立临时目录使用根依赖的离线 store，仅安装生产依赖。隔离配置和业务凭据，核对开发入口、编译服务与 HTTP health，再跑完整编译浏览器 QA；失败或取消清理自有进程和临时目录。
- GitHub Actions 使用 Node 22、pnpm 10.4.1、一次性 MySQL 8 和 Chromium，执行迁移、完整测试、生产构建、纯生产依赖与实际网页回归，并保存报告、日志和截图。

## 验证

本地完整测试 201 通过，4 条 MySQL 集成用例按设计等待一次性数据库；类型检查、生产构建与真实 Edge 网页回归通过。云端执行结果直接见 [Verify ARCANE](https://github.com/hsiaozzz/fly/actions/workflows/ci.yml)，不要把本地跳过的用例算作通过。

移除模板注入后生产 HTML 为 550 字节；主入口 928.85 KB、gzip 281.07 KB。相对原始审查的 gzip 448.50 KB 减少约 37.3%。Monaco 按需加载块仍约 3.98 MB、gzip 1.03 MB；未测首屏时间。第一轮证据保留为当时快照，当前结果应查看本轮工作流。

临时 MySQL 和 mock 对象存储验证事务与访问控制，UI 模型／认证／存储接口仍为受控 fixture。CI 不接业务数据库，不上传外部对象、不部署、不使用计费模型；它没有证明真实模型生成质量、真实 OAuth/对象存储联调或生产沙箱有效。

下一阶段按 [路线图](../ROADMAP.md) 推进独立 staging 联调、真实模型预算内的 30 项评测，再依据失败数据实现玩法验收和素材链路。
