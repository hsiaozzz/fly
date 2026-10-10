/**
 * 生成 demo/long-wind.html。
 *
 * 与编译器共用同一份引擎源码与数据表，保证「仓库里能双击打开的游戏」
 * 和「管线生成出来的游戏」永远一致——改引擎只需重新跑一次这个脚本。
 *
 *   pnpm tsx tools/gen-journey-demo.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_JOURNEY_DATA } from "../shared/game/journeyData";
import { JOURNEY_ENGINE_JS, journeyShell } from "../shared/game/journeyEngine";

const out = resolve(process.cwd(), "demo/long-wind.html");
const html = journeyShell("长风万里 · 骑马环游世界", JSON.stringify(DEFAULT_JOURNEY_DATA), JOURNEY_ENGINE_JS);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html, "utf8");
console.log("[gen-journey-demo] wrote " + out + " (" + html.length + " bytes)");
