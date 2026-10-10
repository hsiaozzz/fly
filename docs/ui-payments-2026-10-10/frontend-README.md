# 浅色创作工作台验证

2026-10-10。界面采用暖白、近黑文字与克制的绿色；首页以创意输入、本地示例及真实草稿为主，作品工作台默认试玩，按需打开源码、参数、检查和游戏文档。示例插画与作品示意图为项目内编写的 SVG。本轮界面没有使用 Google Stitch。

前端类型检查、Vite 生产构建及三个实际 Edge 浏览器流程检查通过，机器摘要见 [frontend-verification.json](frontend-verification.json)。项目流程见 [project-flow-smoke.json](project-flow-smoke.json)，游戏实际尺寸、滚动、模式切换与 330px 布局见 [workspace-layout-results.json](workspace-layout-results.json)。这些检查使用受控 API，不代表真实模型、OAuth、数据库、对象存储或支付平台已经联调。

截图：

- [桌面首页](home-desktop.png)、[手机首页](home-mobile.png)、[330px 首页](home-compact.png)
- [桌面试玩](layout-workspace-desktop.png)、[手机试玩](layout-workspace-mobile.png)、[330px 试玩](layout-workspace-compact.png)
- [桌面源码模式](source-desktop.png)、[330px 源码模式](source-compact.png)
- [发布流程](project-publish.png)、[手机项目](project-mobile.png)、[本地示例](offline-example-mobile.png)

模式切换保留同一个 iframe；编辑源码和参数按现有文档逻辑更新预览。示例的画布、开始与重开按钮在试玩和编辑模式中完整位于 iframe 视口，不依靠自动滚动。任意生成游戏仍需各自验证布局与玩法。

支付检查证据由支付测试单独记录在 payment/ 下。
