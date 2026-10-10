# GameFactory-3A 代码级深度解析

> 配套：[`GameFactory-3A-深度分析.md`](./GameFactory-3A-深度分析.md) 是**架构/战略层**
> 本文是**代码/战术层**——把 1258 个文件、11.6 万行逐个拆开看完后的实现级发现。
> 本地副本：`_tmp_tests/GF3A/`（`git clone --depth 50`）

---

## 0. 先看结论

拆完整座工厂，最值钱的三样东西不是模型封装，而是：

1. **`spec` 声明式建模 + 8 道门禁 + 6 种停因的有界自修正**（`operators/gen_3d_object/funcs/code_asset.py`）
   —— 这是全仓库唯一有**原创算法思想**的地方
2. **契约偏离的逐条书面化**（`models/gen_3d_object/meshy_model.py` 的 C1–C9）
   —— 把"云 API 不适配本地权重契约"这件事，变成可审查的文档而非隐式 hack
3. **把易错且不可见的约束做成随框架分发的自动化测试**
   （`three_js/plugin/A3GamePlayable/tests/orientation.spec.js`）

以及一份**踩坑档案**——代码注释里明确写了"我们被这个坑过"，共 12 处，见第 9 节。

---

## 1. 代码全景

| 目录 | 行数 | 代码文件 | 说明 |
|---|---:|---:|---|
| `engine_adapters/` | **40,469** | 509 | 最大块，5 引擎适配 + 运行时框架 + 示例游戏 |
| `models/` | **29,704** | 167 | 模型封装（含 vendored 上游源码） |
| `test/` | **18,041** | 32 | 测试占比极高（15.5%），工程纪律信号 |
| `operators/` | **14,179** | 72 | 任务语义层 |
| `pipeline/` | **10,349** | 43 | 跑批与评分 |
| `scripts/` | 3,430 | 4 | 安装与导入 |
| 合计 | **~116,000** | | 不含 `test_data/`（72 个 jsonl）与 `third_party/` |

**文件构成**：652 py / 95 md / 77 cs / 72 jsonl / 70 txt / 42 js / 36 json / 33 h / 32 gd / 25 sh / 25 cpp / 15 uid / 13 asmdef / 8 uplugin / 8 tscn / 5 cu

**单文件最大**：`test/test_godot_adapter.py` (7354 行)、`test/test_3d_object_spec.py` (3275 行)、
`browser_serving/frontend/player/viewer.js` (2702 行)、`three_js/.../vfx-kit.js` (1914)、
`ue5/assets/_internal/preprocessors/ply_mesh.py` (1725)、`scripts/import_generated_asset.py` (1707)

> 测试代码 18k 行 vs 业务代码 98k 行 ≈ 1:5.4，且两个超大型测试文件都对着**契约最重**的模块
> （Godot 适配器 + spec 建模）。这是有意识的资源分配。

---

## 2. 地基：`pipeline/common/paths.py`（427 行）

| 设计 | 实现 |
|---|---|
| 四元组寻址 | `(game_id, run_id, task_kind, task_id)` 唯一确定一个产物 |
| 三层映射表 | `TASK_LAYER`（层目录）/ `TASK_INPUT_DIR` / `TASK_JSONL` / `TASK_COLLECT_JSONL` |
| 零依赖 | 只 import `json/os/subprocess/sys/datetime/pathlib/typing` —— 任何地方（含 CPU 工具）都能 import |
| 输出可迁移 | `AAAGF_OUTPUT_ROOT` 环境变量，产物太大时整个树挪到 scratch 盘 |
| 可复现 | `run_meta.json` 记录 `git_sha` + `argv` + 时间戳；同 run 多 task_kind 时**把旧 meta push 进 `history` 数组**而非覆盖 |
| `latest` 软链 | 每次写 summary 时重指向；`OSError` 静默通过（无 symlink 支持的文件系统不算致命） |
| 游戏归属推断 | `infer_game_id`：显式 `game_id` → 任一字段路径里含 `test_samples/<x>` → fallback → `_scratch` |

**细节亮点**：`iter_tasks` 跳过空行和 `//` 注释行，且 `game_id` 解析与 `--game` 过滤在**所有 runner 中行为一致**。

---

## 3. 模型层：`models/`

### 3.1 `models/common/cloud_api.py`（557 行）— 云 API 的九个硬功夫

这是全仓库工程密度最高的文件之一。它"只知道 HTTP、钱和失败模式"：

| 机制 | 实现 |
|---|---|
| **错误分类先看 body 再看状态码** | Tripo 用 **403** 回"credit 不够"，和"key 错了"同码。所以先匹配 body 里的 `insufficient / enough credit / quota exceeded / balance` 等措辞 → `CloudAPIQuotaError`，再判 401/403 → Auth |
| **可重试 vs 终态分离** | `RETRYABLE_STATUS = {408,409,425,429,500,502,503,504}`、`TERMINAL_STATUS = {400,401,402,403,404,405,413,415,422}` |
| **指数退避 + 尊重 Retry-After** | `backoff * 2**attempt`，有 `Retry-After` 头则优先（上限 60s） |
| **内容寻址响应缓存** | `ResponseCache`：`<cache_dir>/<provider>/<sha256>.<ext>` + `.meta.json`。key = 请求全量（含 image 的 sha256，**绝不含 API key**）→ 相同请求永不二次计费 |
| **submit→poll→download 阻塞封装** | `poll_task(fetch, done_states, failed_states, ...)`，超时后异常**携带 task_id**，因为服务端通常还会跑完，事后能取 |
| **下载体积上限** | `download(url, max_bytes=...)` —— "防止错误 URL 撑爆磁盘" |
| **requests 懒加载** | import 时只依赖 stdlib，首次使用才 import requests，保证 `smoke.py` 在无 requests 机器上照样跑 |
| **key 指纹脱敏** | `redact(key)` → `abcd…xy (len 32)`，可安全写进日志和 meta.json |
| **契约守卫** | `image_to_png_bytes` **显式拒绝路径参数**："models take an image object, not a path (R3.2)" |

### 3.2 `meshy_model.py`（463 行）— 契约偏离的书面化

文件头列了 **C1–C9 九条契约偏离**，每条映射到 `api_model_require.md` 的 R9.x：

```
C1 model_path 改为"模型版本 id"（meshy-6）而非权重路径
C2 device 参数仅为接口对齐而保留，实际忽略
C3 无 @torch.no_grad()（torch 根本不参与）
C4 unload() 是 no-op，只关 HTTP session
C5 seed 仅 text-to-3D 支持；可复现性服务端不保证，本地绝不伪造
C6 任务式 API；text-to-3D 两段（preview→refine），refine 是另一次计费
C7 infer_and_save 是 R1.2 的 documented exception
C8 cache_dir 防重复计费
C9 max_retries + 指数退避，可重试/终态分离
```

**三个内行细节**：
- `_clamp_polycount`：TRELLIS.2 默认 1,000,000 面，Meshy 只接受 100–300,000。
  在 wrapper 内部钳制并 `logger.warning`——**宁可吞下差异也要保持后端可互换（R6）**
- `negative_prompt` 不支持时**显式 ValueError**，而非静默丢弃
- 记录 `preview_url`（服务商自己的缩略图）但不下载——注释写得很透：
  > "资产存在"和"资产是对的"是两种不同的断言，只有一张图能解决第二种

### 3.3 `trellis_2_model.py`（158 行）— 薄封装里的两个真坑

```python
# 故意不把 o-voxel/ 加进 sys.path：
# 会遮蔽 pip 安装的 o_voxel（那个才含编译好的 _C.so）
```
以及**先探测扩展再加载**：
```python
import o_voxel; assert hasattr(o_voxel, "_C")
```
注释解释：否则错误会被 pipeline 加载吞掉，最终表现为**一个误导性的 HuggingFace 401**。

其他：`simplify(16_777_216)` 是 nvdiffrast 顶点上限；`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`。

---

## 4. 算子层：`operators/` — 全仓库最有原创性的部分

### 4.1 `code_asset.py`（1739 行）：声明式建模

**核心哲学**（文件头原文转述）：
> 用生成去做车床能精确表达的东西，等于花 100 倍三角面买一个近似值——
> 而且这个近似值**再也没法通过改一个数字来调整**。
> 生成器负责公式说不出的形状（握把的手指凸起），spec 负责 prompt 说不出的尺寸
> （导轨的 30mm 槽距）。

**7 种图元 + mesh 混合**：`box / cylinder / cone / sphere / torus / lathe / extrude` + `mesh`（读磁盘 GLB）

**`spec` 相对生成的三个天然优势**：
1. `forward_axis` 是**陈述**的 → 导入记录为 `verified_by="spec"` 而非 `"heuristic"`
2. `scale_hint_metres` 是陈述的 → 网格有真实尺寸，不用人眼缩放
3. **部件 id 保留为 glTF 节点名** → 导入后轮子还能转（重建网格是融合的单体）

### 4.2 八道门禁（`GATES`）

| 门禁 | 检查 |
|---|---|
| `check_solidity` | 实体性 |
| `check_chirality` | 手性 / 左右对称对（`-l`/`-r` 后缀配对） |
| `check_scale` | 尺度合理性（`PLAUSIBLE_HEIGHT_M` 按 asset_type 给区间） |
| `check_budget` | 三角面预算 |
| `check_connectivity` | 连通性 |
| `check_provenance` | 来源（哪些部件是取的而非推的、代价是什么） |
| `check_orientation` | 朝向 |
| `check_windings` | **放最后**——唯一评估 mesh 的门，成本随三角面数而非部件数增长 |

`run_gates` **即使一个失败也跑完全部**：
> 修正循环需要完整缺陷清单。一次只修一个缺陷，是"让一个有 3 个缺陷的 spec 耗尽有限循环"的方式。

### 4.3 `correct_spec` — 六种停因（这是我最想让你看的一段）

设计动机写在 docstring 里：
> **参考实现 img2threejs 里有个无界循环，花了 45 分钟记录一辆从没动过的车**：
> 一个 lookup 返回 `None`，循环在优化一个看不见它的指标，而什么都不 raise。

于是这里区分**一个循环收敛失败的四种方式**，因为应对方式不同（更用力修 / 换个修法 / 停下来报告 spec 本身错了）：

| stop_reason | 含义 | 应对 |
|---|---|---|
| `passed` | 全绿 | — |
| `exhausted` | 尝试预算耗尽（MAX_ATTEMPTS=3，对齐 img2threejs） | 报告 |
| `repeating` | 相同缺陷集回来了 | 上一轮修正一个都没解决，再试无益 |
| `oscillating` | 两轮前的缺陷集回来了 | 修正在"用 A 缺陷换 B 缺陷" |
| `no_progress` | 缺陷数没减少（但缺陷不同） | 区别于 repeating |
| `revise_failed` | 修正器抛异常 | **报出来，绝不吞** |

还有两个细节：
- 只在**有前一轮**时才判这四种（"拿第一轮和空集比，是循环还没开始就停下的原因"）
- 全程维护 `best`（缺陷最少的那版 spec），失败时返回**最好的那版**而非当前版

### 4.4 `verified_by` 三级真值体系（`operator.py`）

| 值 | 含义 |
|---|---|
| `heuristic` | 从输入视图猜的朝向 |
| `spec` | spec 陈述的，无需确立 |
| `spec+generated` | 放置是陈述的，但混入的 mesh 部件朝向是**断言**的 |

docstring 原句极精彩：
> "a guess labelled as checked stops anyone checking"
> （一个被标成"已核验"的猜测，会阻止任何人再去核验）

以及：混合体若仍标 `spec`，等于**把一个未核验的朝向藏在唯一一个意为'绝不是猜的'的标签后面**。

### 4.5 其他算子细节

- **`strip_ground_plate` 默认开**：image-to-3D 会在主体下方推断出一块地板，占约 1/5 三角面预算。
  **spec 路径故意不运行**——spec 不会发明地板，运行会误删用户要的基座
- **`glb_path` key 永不改名**：即使输出 FBX 也叫 `glb_path`，"重命名返回 key 会破坏 eval.py 和 test/"
- **gate 失败同时进 `warnings` 和 `gates`**：只躺在嵌套 dict 里的门禁失败，就是本模块要对抗的静默早退
- **concept image 存到 mesh 旁边**："坏的资产几乎总是坏的概念图，如果输入被丢掉，事后无法诊断"
- **`framing.touched_border`** → 警告"主体画到边界外，网格大概率被截断，换个 seed 重生成"

---

## 5. `models/common/glb_writer.py`（1363 行）：纯 Python 手搓 GLB

零第三方依赖，自己实现：
- 7 种图元的顶点/法线/索引生成（`_box` 带 chamfer、`_cylinder`、`_cone`、`_sphere`、`_torus`、`_lathe`、`_extrude`）
- `rotated_bounds`（旋转后包围盒）、`euler_matrix`、`apply_matrix`
- `_pad`（4 字节对齐）、`_texture_budget`（按部件尺寸给纹理预算）、`_fit_texture`
- `write_spec_glb` 主入口

**这就是 spec 路径不需要 GPU、不需要 trimesh、不需要任何三方库的原因。**

---

## 6. 流水线层：`pipeline/`

### 6.1 `run.py` / `eval.py` 的铁律

- `eval.py` **禁止** import `run.py`、禁止加载模型、禁止触发生成，只解析已有 `game_id/run_id` 的产物并评分
- 五个标准函数：`load_*` / `make_operator` / `generate` / `run_from_jsonl` / `main`
- `generate()` **不**加载模型、**不**构造 Operator（已管理模型的调用方可用 `operator.run(inp)`）
- 统一 CLI：`--game` / `--tasks` / `--run-id` / `--out-dir` / `--device`

### 6.2 `code_gen`：AI 生成玩法/UI 的契约

**`mechanic_contract.json`** —— AI 生成的玩法必须自证：

| 字段 | 校验 |
|---|---|
| `schema_version` | 必须等于 `gamefactory3a.mechanic_contract.v1` |
| `contract_version` | 正整数（且排除 bool） |
| `gameplay_module` | 必须与期望模块名一致 |
| `state` / `events` / `commands` | 三者均非空集合 |
| `public_api_paths` | 非空、相对路径、**禁止 `..`（路径穿越防护）**、必须真实存在、必须在 workspace 内、不许重复 |

最后一条是**安全设计**：AI 生成的代码声明的公开 API 路径不能逃逸工作区。

`gen_ui` 同构但更重：`packet.py` 1251 行、`artifacts.py` 948 行（vs mechanic 的 407 / 499）。

---

## 7. 引擎适配层：`engine_adapters/`

### 7.1 统一 Client 契约

| 引擎 | 入口 | 命名空间数（实测） |
|---|---|---:|
| three.js | `ThreeClient` | **13** |
| Godot 4 | `GodotClient` | **12** |
| README 声称 | — | **11** ⚠️ |

three.js 的 13 个：`project / build / testing / playtest / plugin / assets / animation / bindings / world / reflection / preview / runtime / observe`

Godot 的 12 个：**无 `preview`**，其余相同。

> ⚠️ **文档滞后于代码**：README 写"11 个命名空间"，实测 three.js 13 / Godot 12，且集合不完全相同。
> "统一契约"是**进行中的目标**，不是已达成状态。

### 7.2 three.js 运行时框架 `A3GamePlayable`

```
src/engine/    animation-director · asset-library · collision-probe · hud-layer
               input-router · motion-kit · runtime-channel · runtime-host
               scene-loader · vfx-kit · visual-kit
src/components/ identity-component · runtime-entity-component
src/subsystems/ runtime-subsystem · world-session-subsystem
src/interfaces/ contracts.js
```

### 7.3 ⭐ `orientation.spec.js` — 把不可见约束做成随框架分发的测试

文件头注释：
> 这是框架自带的测试，检验 **glTF 无法承载的那个属性**。
> 它随 `A3GamePlayable` 一起分发，`three.plugin.install_framework` 会把它复制进每个生成的项目，
> 于是每个项目的 `vitest run` **免费**验证朝向契约。
> 生成的游戏不需要知道它存在，只需要**不破坏它**。

被测不变量：
> 朝向修正必须在游戏**自己每帧设置 `rotation.y` 之后**依然成立
> （每个角色控制器都这么做）。

**这个思路极其值得抄**：找一个"容易做错、做错了又看不出来"的性质，
写一个跟着框架走、对所有下游项目自动生效的测试。

---

## 8. `browser_serving`：多引擎 Web 游玩层

```
backends/    godot_example.py · ue5_example.py · unity3d_example.py · _pixel_streaming.py
frontend/    admin.py · player/{viewer.js(2702行), viewer.html, viewer.css}
gateway/     app.py
client/      client.py · http.py · exceptions.py
             launcher.py · registry.py · service.py · config.py · contracts.py
```

`service.py` 的能力：`health / list_engines / engine_status / stage_and_import / import_descriptor /
list_assets / asset_groups / inspect_asset / list_worlds / call_session / viewer_config`

UE5 走 **Pixel Streaming**（`_pixel_streaming.py`）——重型引擎在云端渲染、浏览器只收视频流。

---

## 9. 🏆 踩坑档案（代码注释里明写的"我们被坑过"）

这是本次深挖**最值钱的输出**——12 条真实的工程教训：

| # | 坑 | 出处 | 解法 |
|---|---|---|---|
| 1 | 无界自修正循环跑 45 分钟，记录一辆从没动过的车（lookup 返回 None，指标看不见它） | `code_asset.correct_spec` | 6 种 stop_reason + MAX_ATTEMPTS=3 |
| 2 | 一次只修一个缺陷 → 3 个缺陷的 spec 耗尽有限循环 | `run_gates` | 即使失败也跑完全部门禁 |
| 3 | Tripo 用 403 报"欠费"，与"key 错"同码 | `cloud_api.classify_http_error` | 先匹配 body 措辞再判状态码 |
| 4 | `o_voxel._C` 缺失 → 错误被吞 → 表现为误导性的 HuggingFace 401 | `trellis_2_model` | 加载前先 `assert hasattr(o_voxel, "_C")` |
| 5 | 把 `o-voxel/` 加进 sys.path 会**遮蔽 pip 包的 `_C.so`** | `trellis_2_model` | 只加 `trellis2/` 纯 Python 部分 |
| 6 | image-to-3D 在主体下方推断出地板，占 1/5 面数预算 | `operator.run` | `strip_ground_plate` 默认开（spec 路径关） |
| 7 | 上游 HunyuanWorldMirror 用同一删除动作回答两个问题 → 固体表面打穿成筛子 | `gen_3d_scene/funcs` | mask 只判像素、points_to_mesh 只判面（覆盖率 82%→99%+） |
| 8 | 深度头把天空预测成有限深度 → mesh 出一幕天幕curtain | `models/README` | 只能靠 `SkySegmentationModel` 分割 |
| 9 | TRELLIS 默认 100 万面，Meshy 只收 30 万 → 400 终态错误 | `meshy._clamp_polycount` | wrapper 内部钳制并警告 |
| 10 | 编辑器已打开时导入，资产浏览器不刷新 → 看起来"静默失败" | `engine_install/README` | 导入前必须关闭项目 |
| 11 | 概念图主体画到边界外 → 网格被截断，裁剪无法凭空发明 | `operator.run_art_plan` | 检测 `touched_border` 并警告换 seed |
| 12 | 坏的资产几乎总是坏的概念图，但输入图被丢掉后无法诊断 | `operator.run_art_plan` | concept.png 与 model.glb 同目录保存 |

---

## 10. 代码质量评估

### ✅ 优点

- **契约先于代码**：`agent_skills/develop_harness/` 有 4 份契约文档（model / api_model / operator / pipeline），
  代码里的每处偏离都**标注条款号**（C1–C9 对应 R9.1–R9.9）
- **注释解释"为什么"而非"是什么"**：几乎每个非常规实现都写着**被哪个具体失败塑造的**
- **向后兼容当成硬约束**：`glb_path` 永不改名、`output_dir` 存在即走 legacy 路径、smoke 测试双模式
- **可观测性**：`run_meta.json`（git sha + argv）、`last_call_info`（云调用成本/三角面/耗时）、
  `meta.json` per task
- **测试资源集中在契约重的模块**：Godot 适配器 7.3k 行测试、spec 建模 3.3k 行测试

### ⚠️ 瑕疵

| 问题 | 证据 |
|---|---|
| **文档滞后于代码** | README 说 11 个命名空间，实测 three.js 13 / Godot 12 且集合不同 |
| **空占位目录** | `operators/process_input`、`operators/gen_ui` 的 `operator.py` 为空；多数 `metrics/` 只有 2 个实现 |
| **Windows 支持弱** | 大量 bash 脚本；`gen_motion/install.sh` **直接 `exit 2`**（Linux-only，Windows 需 WSL2）；UE/Unity 路径硬编码 `C:\Program Files\` |
| **无 release / 无 CI 迹象** | 仓库无 release；未见到 `.github/workflows` |
| **命名不一致** | `AAA GF` / `A3GAME` / `AAAGF` 三套环境变量前缀并存（`AAAGF_*` 与 `A3GAME_*`，文档称 `AAAGF_*` 为 legacy） |
| **拼写错误** | `operatar_require.md`（应为 `operator_require.md`） |

---

## 11. 对 ArcaneGame 的落地建议（比 V1 更具体）

### 🥇 第一优先：`correct_spec` 的 6 种停因 → 搬进你的 Validator

你的 GameSpec 流水线是 `Planner→Normalizer→Validator→IR→Compiler→Runtime`。
我建议把 **Validator 从"校验器"升级为"有界自修正器"**，直接复用这套：

```
run_gates(spec)  →  failures  →  revise(spec, failures)  →  re-gate
                                  ↑ 最多 3 次
stop_reason: passed | exhausted | repeating | oscillating | no_progress | revise_failed
```

**为什么这对你特别重要**：你已经有 `runtimeCoder 失败降级到 adaptiveEngine` 的补丁——
那是"失败了怎么办"。而 `correct_spec` 解决的是**"失败前怎么收敛"**，且能区分
"再试一次有用" vs "再试也是同样的错"。
**`repeating` 和 `oscillating` 这两个信号，能省掉大量无意义的重试 token。**

另外三条可直接抄：
- 即使一个门禁失败也**跑完全部**（拿到完整缺陷清单）
- 维护 `best`，失败时返回**缺陷最少的那版**
- `revise_failed` 报出来**绝不吞**（对应你"错误信息要强 pushback、要根因"的偏好）

### 🥈 第二：门禁清单 → 你的 IR 校验

8 道门禁里，有 4 道对你的数据驱动引擎（`cfg.entities`）直接可用：
`check_scale`（尺度合理性）、`check_connectivity`（连通）、`check_orientation`（朝向）、
`check_budget`（预算）。

特别是 `PLAUSIBLE_HEIGHT_M` 按 asset_type 给合理身高区间——
你的 `defenseEngine/gomokuEngine/xiangqiEngine` 解释 `cfg.entities` 时，
完全可以用同样的表拦住"AI 生成了一个 50 米高的士兵"。

### 🥉 第三：`orientation.spec.js` 模式 → 你的引擎层

找一个"容易做错、做错了看不出来"的性质（朝向显然是最典型的一个），
写进引擎自带测试，让**每个生成的游戏**跑测试时自动验证。
你的 adaptiveEngine 是手写的，加这个成本极低、收益极高。

### 补充：VLM 审查的具体接入点

V1 建议把 7 行验收表接进 VLM。现在有了代码级认知，接入点更清晰：

| 检查项 | 自动化程度 | 接入方式 |
|---|---|---|
| Facing while moving | **可完全自动化** | `orientation.spec.js` 模式 → 单元测试，不必麻烦 VLM |
| Combined parts（武器在不在手里） | 半自动 | 包围盒/插槽几何断言 + VLM 双保险 |
| Style match | **必须 VLM** | 你的 nemotron 视觉栈 |
| Playability / 相机穿墙 | VLM 看录屏 | 需要录屏基础设施（可参考 `browser_serving`） |

**结论：VLM 应该只负责它不可替代的部分（风格、可玩性观感），
几何类问题用确定性断言解决——更便宜、更可靠、可回归。**
这正是 GameFactory-3A 自己在 `orientation.spec.js` 里践行的思路。
