# GameFactory-3A（3AGameFactory）深度分析

> 仓库：https://github.com/OpenDCAI/GameFactory-3A
> License：Apache-2.0 ｜ 主语言：Python ｜ 分析日期：2026-09-05

---

## 0. 一句话结论

**它不是一个「游戏生成模型」，而是一套给 Coding Agent 用的「工具带 + 验收规范」。**

仓库里没有一个自研的生成模型，全部是对现有 SOTA（TRELLIS.2 / Meshy / Tripo / Qwen-Image-Edit / MoMask / Puppeteer / Seedance / MiniMax-H3 …）的**薄封装**，
真正的创新在**工程层**：一套严格的三层契约、一份 5 引擎统一适配层、以及一份「必须录屏自玩才算验收」的硬规范。

这个定位非常清醒：**不跟模型赛跑，做模型之上的装配线。**

---

## 1. 项目画像（数据为 2026-09-05 实测）

| 指标 | 值 |
|---|---|
| Stars / Forks / Issues | 373 / 25 / 8 |
| 创建时间 | 2026-07-06（约 2 个月） |
| 最后推送 | 2026-09-05（**当天活跃**） |
| 代码体积 | 6.72 MB（languages API 实测） |
| 语言构成 | Python 75.2%、JavaScript 8.8%、C# 8.6%、C++ 3.8%、GDScript 1.9%、CUDA 0.6%、Shell 0.5% |
| Release | 无正式 release（仓库仍在 pre-release 打磨期） |
| 默认分支 | main |
| 组织 | OpenDCAI（Data Foundation / 开放数据中心 AI 方向） |

**活跃度解读**：2 个月 373 star、25 fork、8 issue，PR 编号已到 #61，最近提交集中在
`playtest`、`godot-pipeline-fix`、`tripomotion`、`add unity` —— 说明团队正在**补齐引擎侧的
「可玩性验证」闭环**，而不是在堆新模型。这是成熟信号。

---

## 2. 架构：三层契约 + 一个双通道

```
                    ┌──────────────────────────────────────┐
                    │  Agent 驱动层（Codex / Claude Code）  │
                    │  读 agent_skills/*.md 自主编排        │
                    └──────────────┬───────────────────────┘
                                   │ 调度
        ┌──────────────────────────┴──────────────────────────┐
        │                                                     │
   【资产通道】                                        【代码通道】
        │                                                     │
  Layer 3  pipeline/assets_gen/<task>/                 pipeline/code_gen/
           run.py（生成）+ eval.py（评分）              gen_mechanic/ gen_ui/ playtest/
        │                                                     │
  Layer 2  operators/<task>/operator.py                       │
           funcs/（解耦步骤）+ metrics/（评分）                │
        │                                                     │
  Layer 1  models/<family>/<model>_model.py                   │
           load() / infer() / unload()                        │
        │                                                     │
        └──────────────────────────┬──────────────────────────┘
                                   │
                    engine_adapters/{ue5,unity3d,godot,blender,three_js}
                    统一 Client 契约（11 个命名空间 + 统 一返回体）
```

### 2.1 铁律：依赖只向下

```
models/     知道：权重、dtype、device、自家 API        ✗ 不知道：任务、jsonl、输出路径
operators/  知道：任务语义、产物命名、meta             ✗ 不知道：具体哪个模型、argparse
pipeline/   知道：argparse、ckpt 解析、jsonl、汇总     ✗ 不知道：模型内部、产物字节布局
```

跨层装配**只允许发生在一处**：`run.py` 的 `make_operator()`。
这是教科书级的依赖倒置，配合 `test/harness/stubs.py` 的 stub 模型，
实现**「无 GPU、无权重、毫秒级跑通全链路」**的 smoke 测试。

### 2.2 值得抄的工程细节

| # | 机制 | 说明 |
|---|---|---|
| 1 | **paths.py 单一真源** | 所有产物路径必须走 `pipeline/common/paths.py`；`grep -rn "outputs/" operators/ models/` 必须为空，否则算 bug |
| 2 | **新增任务只需改 4 张表** | `TASK_LAYER` / `TASK_INPUT_DIR` / `TASK_JSONL` / `TASK_COLLECT_JSONL`，无第二处注册点 |
| 3 | **eval 与 run 彻底隔离** | `eval.py` 禁止 import `run.py`、禁止加载模型、禁止触发生成，只评分已有产物 |
| 4 | **向后兼容硬约束** | 永不删除/重命名返回 dict 的 key；新行为必须走**带默认值的新参数**（默认值复现旧行为）；smoke 测试同时跑新旧两种布局 |
| 5 | **五引擎统一 Client 契约** | `UEClient`/`UnityClient`/`GodotClient`/`ThreeClient`/`BlenderClient` 暴露**同样的 11 个命名空间**和 `{ok, operation, artifacts, diagnostics, warnings, errors, payload}` 返回体 → 上层代码零分支切引擎 |
| 6 | **Adapter 自有框架** | 每个引擎自带 `A3GamePlayable` / `A3GameRuntime` 运行时框架，生成的玩法只**扩展不修改**框架（three.js 版即 npm 包 `@a3game/playable`） |

---

## 3. 能力矩阵

### 3.1 资产生成（pipeline/assets_gen）

| 任务 | 可用后端 | 类型 |
|---|---|---|
| `gen_tpose_image` | Qwen-Image-Edit + RMBG-1.4 / Depth-Anything | 本地权重 |
| `gen_3d_object` | **TRELLIS.2**（本地）、**Tripo**（云）、**Meshy**（云） | 混合 |
| `gen_3d_scene` | WorldMirror（vendored HunyuanWorldMirror）+ WorldPlay（HY-WorldPlay） | 本地权重 |
| `gen_motion` | Puppeteer（绑骨）+ MoMask（生成）+ bpy 4.2（重定向） | 本地 + 外部源 |
| `gen_audio` | Seed Audio（云）、Qwen3-TTS（本地）、Woosh-DFlow（本地，CC-BY-NC） | 混合 |
| `gen_cg_video` | Seedance（云，$ARK_API_KEY）、MiniMax-H3（云 / 本地 INT8 剪枝 + ComfyUI） | 混合 |

### 3.2 引擎支持

| 引擎 | 适配层 | 产物导入方式 | 特殊前置 |
|---|---|---|---|
| UE5 | `A3GamePlayable` C++ 插件 | Interchange 直接吃 `.glb` | 需开 PythonScriptPlugin；**驱动完整 Editor 而非 commandlet** |
| Unity | `A3GameRuntime` C# 包 | 需装 `com.unity.cloud.gltfast` 6.16.0 | FBX/OBJ 免装；URP/HDRP 材质转换**未测试** |
| Godot 4 | `A3GamePlayable` GDScript 插件 + UDP 桥 | 内置 glTF 导入器，`godot --headless --import` | 官方包 SHA-512 校验安装；**产物注册表失败会回滚文件导入** |
| Blender | `blender/game` Python kit | `bpy`（`pip install bpy` 即可，无需装应用） | `runtime/` 是常驻 UDP JSON 服务，可远程驱动渲染 |
| three.js | `@a3game/playable` npm 包 | Node 侧 `import_mesh.mjs` | 需自建 renderer/帧循环/输入/碰撞（UE 原生有，three.js 没有） |

### 3.3 QA 与验收（agent_skills/）

- `asset_qa/{3d_object, 3d_scene, motion, image, audio, cg_video}/SKILL.md` —— 资产生成 + 视觉审查
- `code_gen/{mechanic, ui}/` —— 玩法与 UI 生成
- `engine_context/{ue5,unity3d,godot,blender,three_js}_api.md` —— 喂给 LLM 的引擎 API 上下文
- `setting_overview.md` —— **总入口**，含完整的 5 步工作流 + 验收表

---

## 4. 最有价值的三处「真功夫」

### 4.1 「编译通过 ≠ 可玩」—— 验收规范

`setting_overview.md` 里最狠的一段：

> "It compiles", "it launches", or "no errors in the log" is **not** validation.

要求 Agent **必须**：
1. 真正跑起来，**执行大部分玩家操作**（移动、跳跃、开火、载具、死亡、重生、暂停、每个 UI 屏）
2. **录一段游玩视频**（非宣传片，是证据）
3. 对着一张 7 行表格逐条审（画质 / 灯光 / 风格 / 特效 / **朝向** / 组合部件 / 可玩性）
4. 修复后**重新录**验证

其中「**Facing while moving**」和「**Combined parts**」两行极其内行——
比如「角色不能倒着走」「武器要在手掌里不在胸腔里」「车轮要在底盘下方四个轮拱处、既不下陷也不悬空」。
这些是**只有真跑过才知道的失败模式**，写进规范里说明团队踩过坑。

还有一条原则我特别认同：
> Fix the cause in its owning layer; never patch an asset problem inside gameplay code.
> （在资产/导入元数据层修朝向，**绝不用玩法代码里的旋转去补偿**）

### 4.2 3D 场景网格的「破洞修复」

`operators/gen_3d_scene/funcs/` 的存在理由被明确写进 README：

上游 HunyuanWorldMirror 用**同一个删除动作**回答两个不同问题——
「这个像素有效吗？」和「这个像素在不连续处吗？」。
但不连续性属于**两个像素的边界**，不属于其中任何一个，于是固体表面被打穿成筛子。

修法：`scene_mask.py` 只判**像素**，`points_to_mesh.py` 只判**面**（切平面测试）。
**保留覆盖率从约 82% 提升到 99%+。**

剩下两个伪影单独处理：
- **天空**被深度头预测成有限深度 → 只能靠 `SkySegmentationModel` 分割剔除（深度头表达不了「无限远」）
- 遮挡边界被糊成斜坡 → 每张面自己法线 vs 继承法线的对比才能抓到

并且提供了三个**无需权重和 GPU** 的诊断工具：`eval.py --self-check`、`--contract-check`、`render.py scene.glb`（离屏光栅化，洞和橡皮膜肉眼可见）。

### 4.3 资产决策策略：不迷信生成

> 对成熟品类（尤其 3D 物体）→ 优先云端闭源 API；
> 对不成熟品类（尤其 **motion 和 3D 场景**）→ 优先用引擎资产库的**授权资产**，
> 因为那样更可靠、更可交付。

付费云后端必须**先停下来问用户**：给出购买/API key 页面、估算费用、要 key、**等待**。
不许绕过登录墙或授权源爬取。

这是**工程诚实**，比「全流程 AI 生成」的营销话术值钱得多。

---

## 5. 使用成本 / 磁盘占用（⚠️ 以下为基于依赖清单的**推算**，非实测）

代码本体只有 6.72 MB，但配套环境是大头。

| 类别 | 估算 | 依据 |
|---|---|---|
| 仓库 checkout | **~7 MB** | languages API 实测 6.72 MB |
| **Motion 运行时**（Puppeteer + MoMask + retarget） | **15 – 30 GB** | 3 个 conda env：torch 2.1.1+cu118 ×2、cuda-nvcc 11.8 工具链、pytorch3d、flash-attn 2.6.3（需编译）、tetgen、bpy 4.2、SMPL/SMPL-X + MoMask + Puppeteer 权重 |
| **本地生成模型权重** | **50 – 150+ GB** | TRELLIS.2、Qwen-Image-Edit-2511（20B 级）、MiniMax-H3 INT8 剪枝 + ComfyUI、WorldMirror + HY-WorldPlay |
| Godot 4 | **~1 GB** | 官方归档，SHA-512 校验安装 |
| Blender（`pip install bpy`） | **~0.5 GB** | 无需装应用 |
| Unity Hub + Editor | **~30 GB** | 官方体量 |
| UE5 | **100 GB+** | 官方体量 |

### 给「硬盘敏感」用户的轻量路线（推荐）

```
引擎    → Godot 4（~1GB）或 three.js（纯 npm，几十 MB）
资产    → 全部走云端 API（Meshy / Tripo / Seedream / Seedance / Seed Audio）
        → 支持 --skip-weights 跳过本地权重下载
玩法/UI → pipeline/code_gen 直接驱动，无需本地生成模型
验收    → browser_serving / Godot headless 录屏
```
**总占用可压到 3–5 GB**，且完全不需要 GPU。代价是云 API 按量付费，且需要 API key。

> 注意：`gen_motion/install.sh` 明确**只支持 Linux**（Windows 需 WSL2），
> 且硬依赖 Conda。这是 Windows 原生用户的一道坎。

---

## 6. 局限与风险

| 风险 | 说明 |
|---|---|
| **Windows 支持弱** | 动捕安装脚本 Linux-only；UE/Unity 路径硬编码 `C:\Program Files\...`；大量 bash 脚本 |
| **无正式 release** | 仍在 pre-release，API 可能变动 |
| **占位目录多** | `operators/process_input`、`operators/gen_ui` 的 `operator.py` 是空的；多数 `metrics/` 包只有 `gen_3d_scene` 和 `gen_motion` 实现 |
| **URP/HDRP 未验证** | Unity 仅验证 built-in 渲染管线 |
| **第三方许可混杂** | Woosh-DFlow 权重为 **CC-BY-NC（不可商用）**；Apache-2.0 只覆盖本仓库代码，模型/引擎/素材各有其许可 |
| **强依赖闭源 API** | Meshy(100 credits/月免费档) / Tripo(2000 credits 注册赠) / Seedance / Seed Audio 都要 key 和钱 |
| **Agent 质量即上限** | 整套系统的产出质量 = 驱动它的 Codex/Claude Code 的能力，没有兜底 |

---

## 7. 对 ArcaneGame（Arcane AI Studio）的借鉴

| 维度 | GameFactory-3A | ArcaneGame 现状 | 可抄的点 |
|---|---|---|---|
| 分层契约 | models→operators→pipeline，依赖只向下 | GameSpec 流水线（Planner→Normalizer→Validator→IR→Compiler→Runtime） | **IR 层已经等价于它的 operators 层**，建议补一条同样的「依赖只向下」铁律 + stub smoke 测试 |
| 路径管理 | `paths.py` 单一真源 + grep 守卫 | 分散 | 可引入同款守卫脚本进 CI |
| 引擎适配 | 5 引擎统一 Client 契约 + 11 命名空间 | 数据驱动引擎（defense/gomoku/xiangqi/adaptive） | **它的「引擎自有框架 + 生成代码只扩展不修改」** 与 Arcane 的数据驱动引擎思路同源，可互相印证 |
| 验收 | **强制录屏自玩 + 7 行失败模式 checklist** | 有 VLM 视觉栈 | ⭐ **这是最值得抄的一条**。Arcane 已有 VLM（OpenRouter nemotron），正好可以把它的 7 行检查表做进 VLM 自动审查 prompt —— 把「人工看录屏」升级为「VLM 看录屏 + 人工抽检」 |
| 失败修复 | 在归属层修，不用玩法代码补偿资产问题 | — | 可写进 Arcane 的 Validator 规则 |
| 资产策略 | 成熟品类走云 API，不成熟品类走授权资产库 | 以生成为主 | 可引入「生成质量不达标 → 授权资产兜底」的降级路径 |

### 三个立即可落地的动作

1. **把 `setting_overview.md` 的「Validate, play, and iterate」7 行检查表汉化并接入 Arcane 的 VLM 审查**，
   让 `nemotron-nano-12b-v2-vl` 对着录屏逐行判定。
2. **引入「依赖只向下 + stub smoke」**：给 Arcane 的 IR→Compiler 链路加一个无 GPU 的 stub 冒烟测试，
   Arcane 主打浏览器端，比 GameFactory 更容易做到毫秒级闭环。
3. **加入 `paths` 单一真源 + grep 守卫**：一条 shell 断言就能防住手拼路径的历史债。

---

## 8. 快速上手

```bash
git clone https://github.com/OpenDCAI/GameFactory-3A
cd GameFactory-3A
# 打开 Codex / Claude Code / Gemini CLI，说：
#   "先读 agent_skills/setting_overview.md，然后帮我做一个 <引擎> 的 <类型> 游戏"
```

**零 GPU 验链路**（只需 pillow / numpy / scipy）：
```bash
pip install pillow numpy scipy
python test/harness/smoke.py --kind 3d_object
```

**无引擎验导入**：
```bash
python scripts/import_generated_asset.py --src <glb> --engine both --dry-run
```

---

## 9. 许可与合规

- 本仓库代码：**Apache-2.0**（可商用，需保留声明与 NOTICE，含专利授权条款）
- **不覆盖**：第三方引擎（UE5/Unity 各有 EULA）、模型权重（Woosh-DFlow = CC-BY-NC **不可商用**）、
  外部素材库资产、云端 API 产出内容的归属条款
- 仓库明确要求：**记录 provenance 与许可信息**，商用前逐个核实
