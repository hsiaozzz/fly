import type { GameFile, GameSpec } from "./types";
import { DEFAULT_JOURNEY_DATA } from "./journeyData";
import { JOURNEY_ENGINE_JS, journeyShell } from "./journeyEngine";

const file = (path: string, content: string): GameFile => ({
  path,
  content,
  language: path.endsWith(".json") ? "json" : path.endsWith(".md") ? "markdown" : path.endsWith(".html") ? "html" : "text",
});

/**
 * journey 类型的产物与 Phaser 模板不同：它不依赖 npm 安装，输出一个
 * 双击即可运行的自包含 HTML（外加一份可读的 data.json 便于二次编辑）。
 * 理由：这类游戏的价值在内容与数值，把构建链路降到零能让生成器更快被验证。
 */
export function journeyProject(spec: GameSpec): GameFile[] {
  const title = spec.game.title.replace(/[<>]/g, "") || "长风万里";
  const data = spec.data ?? DEFAULT_JOURNEY_DATA;
  const dataJson = JSON.stringify(data, null, 2);
  const html = journeyShell(title, dataJson, JOURNEY_ENGINE_JS);

  return [
    file("index.html", html),
    file("src/data.json", dataJson),
    file("src/engine.js", JOURNEY_ENGINE_JS),
    file(
      "README.md",
      [
        "# " + title,
        "",
        spec.game.description,
        "",
        "## 运行",
        "",
        "直接用浏览器打开 `index.html` 即可，**无需 npm install**，无外部依赖。",
        "",
        "## 操作",
        "",
        "- `空格` / `↑` / 点击 = 跃障",
        "- `1` `2` `3` 或 `←` `→` = 漫步 / 小跑 / 疾驰",
        "- `C` = 旅志图鉴，`M` = 静音",
        "- 移动端：屏幕右下角三个按钮",
        "",
        "## 玩法",
        "",
        `绕旅行线路一圈，途经 ${data.regions.length} 处风貌、${data.nodes.length} 个落脚点。核心张力是「时间 × 马匹状态 × 物资」三选二：`,
        "走险路快但风险高，走平道安全但费时费粮。路上的每个选择都会写进游记，并影响数据表中的结局。",
        "",
        "- 低买高卖：在盐田村买盐，到云岭雪原卖出",
        "- 羁绊解锁：30 跃障强化 / 50 体力节流 / 70 减伤 / 90 障碍预警",
        "- 伤病会拖慢速度，钉蹄铁或药膏可治",
        "",
        "## 改内容",
        "",
        "`index.html` 内嵌了数据与引擎，可独立离线运行。`src/data.json` 和 `src/engine.js` 是编辑用源码副本。",
        "编辑源码副本后，请重新生成 HTML，或同步替换 index.html 内的 window.__JOURNEY_DATA__ 数据块和引擎脚本。单独修改副本不会改变预览。",
        "节点委托和隐藏奇遇由 quests/secrets 数据表驱动。",
      ].join("\n"),
    ),
  ];
}
