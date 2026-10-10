# GitHub 项目仓库与可复现验证

2026-10-10。`hsiaozzz/fly` 作为 ARCANE 项目仓库，保留原仓库初始提交及 Apache 2.0 许可证，以普通合并接入已有本地实现。原 `codex/yt-dlp` 分支不修改。

## 本轮改动

- 仓库首页、描述、主题、package 名称与 repository 信息改为 ARCANE；补贡献、安全说明与分阶段路线图。
- 移除原模板的 Manus runtime、源码定位插件和开发请求 collector，保留 React／Tailwind 构建。开发默认监听本机地址；生产页面不再包含模板运行注入。
- 文档链接改为仓库相对路径；运行凭据、个人配置、恢复归档、依赖和生成输出不发布。
- 增加实际 migration 执行计划、schema 缺字段 readiness、迁移 journal 与重复迁移的回归。
- 网页测试等待慢请求真正到达及草稿实际存储，使用独立随机预览端口并有界清理；浏览器路径支持 Linux、Windows 与已安装 Playwright Chromium。
- QA worker 补 Linux 系统目录白名单；启动及运行错误只记录固定分类，原始 stderr、路径和业务凭据不进入日志或 HTTP 报告。Chromium 保持启用沙箱，CI 在一次性 VM 中允许所需 namespace。
- `pnpm check:production` 在独立临时目录使用根依赖的离线 store，仅安装生产依赖。隔离业务凭据，核对开发入口、编译服务与 HTTP health，再跑完整编译浏览器 QA。POSIX 超时／取消先记录实际自有后代，再有界正常关闭及强杀独立进程组；清理完成后删除临时目录，清理失败则保留目录并返回失败。`pnpm check:process-cleanup` 检查三层独立进程、超时、取消和无关进程保护，并接入 CI。
- GitHub Actions 使用 Node 22、pnpm 10.4.1、一次性 MySQL 8 和 Chromium，执行迁移、完整测试、生产构建、纯生产依赖与实际网页回归，并保存报告、日志和截图。

## 验证

已核对 [GitHub CI 38031225574](https://github.com/hsiaozzz/fly/actions/runs/38031225574)（提交 `fb94597`）的实际产物：210 项测试全部通过，0 失败、0 跳过；其中包含 4 项真实 MySQL 集成测试。类型检查、迁移、生产构建、纯生产依赖导入和 HTTP health、16 项编译浏览器 QA（60 组输入检查），以及工作区和项目发布网页回归全部通过。后续提交结果见 [Verify ARCANE](https://github.com/hsiaozzz/fly/actions/workflows/ci.yml)。

清理补丁的本地最新单元测试 206 通过，Windows 下跳过 4 条 MySQL 集成与 2 条 Linux 专项用例，由 CI 补齐（完整套件共 212 项）。另有 4 条实际 Linux 进程树清理回归通过；真实 Edge 的超时、取消及 IPC 断开实验确认 worker、浏览器和其后代均退出。最新类型检查、生产构建、纯生产依赖下的 16 项编译 QA／60 组输入检查，以及工作区与项目发布网页回归全部通过。先前一次运行在浏览器操作阶段提前退出，被四组输入完整性断言判为失败，未把未完成检查计为通过。以最终提交的云端产物核实 Linux 上的完整执行。

移除模板注入后生产 HTML 为 550 字节；主入口 928.85 KB、gzip 281.07 KB。相对原始审查的 gzip 448.50 KB 减少约 37.3%。Monaco 按需加载块仍约 3.98 MB、gzip 1.03 MB；未测首屏时间。第一轮证据保留为当时快照，当前结果应查看本轮工作流。

临时 MySQL 和 mock 对象存储验证事务与访问控制，UI 模型／认证／存储接口仍为受控 fixture。CI 不接业务数据库，不上传外部对象、不部署、不使用计费模型；它没有证明真实模型生成质量、真实 OAuth/对象存储联调或生产沙箱有效。

下一阶段按 [路线图](../ROADMAP.md) 推进独立 staging 联调、真实模型预算内的 30 项评测，再依据失败数据实现玩法验收和素材链路。
