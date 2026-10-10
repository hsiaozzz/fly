/**
 * 《长风万里》无头冒烟测试：用最小 DOM 桩把整局游戏自动打通一遍。
 *
 *   node tools/smoke-journey.mjs
 *
 * 目的不是断言玩法平衡，而是确保引擎在真实一局里不抛异常、状态机不卡死、
 * 结局可达。改完引擎或数据表都应跑一次。
 */
import vm from "node:vm";
import { loadJourneySource } from "./load-journey-source.mjs";

const { data, engine } = await loadJourneySource();
const dataJson = JSON.stringify(data);
new vm.Script(engine, { filename: "current-journey-engine.js" });

const noop = () => {};
const gradient = { addColorStop: noop };
const ctxStub = new Proxy(
  { measureText: () => ({ width: 12 }), createLinearGradient: () => gradient, setTransform: noop, save: noop, restore: noop },
  { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) },
);
const canvas = {
  width: 960, height: 540, style: {},
  getContext: () => ctxStub,
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
  addEventListener: (type, fn) => ((canvas._h[type] = canvas._h[type] || []).push(fn)),
  _h: {},
};
const store = new Map();
const win = {
  addEventListener: noop,
  devicePixelRatio: 1,
  AudioContext: undefined,
};
const sandbox = {
  window: win,
  document: { getElementById: () => canvas, title: "长风万里" },
  requestAnimationFrame: noop,
  setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; },
  clearTimeout: noop,
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  Math: Object.assign(Object.create(Math), { random: (() => { let seed = 912487; return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }; })() }), JSON, Object, console, isFinite, parseFloat, parseInt, Number, String, Array, Date,
};
sandbox.globalThis = sandbox;
win.localStorage = sandbox.localStorage;

vm.createContext(sandbox);
vm.runInContext("window.__JOURNEY_DATA__ = " + dataJson + ";", sandbox);
vm.runInContext(engine, sandbox);
const G = sandbox.window.__JOURNEY__;

const fail = [];
function check(cond, msg) { if (!cond) fail.push(msg); }

// UI 是即时模式：按钮在 render 时才注册，所以每次操作前先跑一帧。
function frame() { G.step(0); }
function click(label) { frame(); const clicked = G.click(label); frame(); return clicked; }
function key(code) { G.key(code); frame(); }

function tick(seconds) {
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) G.step(1 / 60);
}

// 1. 标题 → 开场事件
key("Enter");
check(G.state().scene === "event", "标题界面按回车后应进入开场事件，实际：" + G.state().scene);
check(click("上马，向西。"), "开场事件应有「上马，向西。」选项");
key("Enter");
check(G.state().scene === "map", "开场事件结束应进入舆图，实际：" + G.state().scene);
key("KeyC"); key("Escape");
check(G.state().scene === "map", "从初始舆图打开图鉴后必须返回舆图");
check(click("落脚休整"), "初始节点应提供落脚休整入口");
check(click("接个委托"), "初始节点应能打开委托板");
const firstQuest = data.quests.find(q => q.node === data.nodes[0].id);
if (firstQuest) {
  check(click(firstQuest.title), "委托板应显示数据表中的委托");
  check(G.state().event?.kind === "quest", "委托必须使用真实任务数据");
  check(click(firstQuest.choices[0].label), "委托应可选择后果");
  key("Enter");
  check(G.state().seen["q:" + firstQuest.id], "完成委托必须记录一次性标记");
  check(G.state().scene === "node", "委托完成应返回节点");
}
click("继续赶路 →");

// 2. 自动打通 21 段路程
let legs = 0, guard = 0, totalFrames = 0;
const bondTrace = [];
while (G.state().scene !== "ending" && guard++ < 400 && totalFrames < 120000) {
  frame();
  const s = G.state();
  if (s.scene === "map") {
    key("Digit2"); // 捷径
    legs++;
    continue;
  }
  if (s.scene === "ride") {
    let frames = 0;
    while (G.state().scene === "ride" && frames++ < 20 * 240) {
      totalFrames++;
      const cur = G.state();
      if (cur.ride && cur.ride.threat) {
        frame();
        const labels = G.buttons().map((b) => b.label).filter(Boolean);
        const pick = labels.find((l) => l.indexOf("2 ") === 0) || labels.find((l) => l.indexOf("1 ") === 0) || labels[0];
        if (pick) { key("Digit2"); check(!G.state().ride?.threat, "遭遇数字键应解析威胁而非切换档位"); } else { fail.push("遭遇卡住且没有可点选项"); break; }
        continue;
      }
      if (frames % 40 === 0) {
        // 模拟玩家按体力切换速度档
        const stam = G.state().stats.stamina;
        G.key(stam > 65 ? "Digit3" : stam > 35 ? "Digit2" : "Digit1");
      }
      // 模拟玩家看到障碍就跃
      const rr = G.state().ride;
      if (rr && rr.grounded) {
        const hx = rr.dist + 300;
        for (const o of rr.obs) {
          if (!o.done && !o.threat && o.x > hx && o.x - hx < 85) { G.key("Space"); break; }
        }
      }
      G.step(1 / 20);
    }
    check(frames < 20 * 240, "第 " + legs + " 段路在 4 分钟内没有跑完（可能卡死）");
    if (frames >= 20 * 240) break;
    continue;
  }
  if (s.scene === "event") {
    const def = s.event && s.event.def;
    if (!s.event.result) {
      const labels = G.buttons().map((b) => b.label).filter(Boolean);
      check(labels.length > 0, "事件「" + (def && def.title) + "」没有任何可点选项");
      if (labels.length) { const chosen = labels.find(label => G.click(label)); if (!chosen) fail.push("事件没有满足条件的选项"); }
    } else {
      key("Enter");
    }
    continue;
  }
  if (s.scene === "node") {
    // 顺便验证商店与关键节点动作都能打开
    if (legs === 3) {
      click("补给交易");
      check(G.state().nodeUi.shop === true, "点击补给交易应打开商店");
      const back = G.buttons().map((b) => b.label).find((l) => l && l.indexOf("← 回到") === 0);
      if (back) click(back);
    }
    bondTrace.push(Math.round(G.state().stats.bond));
    click("接个委托");
    if (G.state().nodeUi.quests) {
      const title = G.buttons().map(b => b.label).find(label => data.quests.some(q => q.title === label && (!q.requires)));
      if (title && click(title)) continue;
      const back = G.buttons().map(b => b.label).find(label => label?.startsWith("← 回到"));
      if (back) click(back);
    }
    if (G.state().stats.fodder < 3 || G.state().stats.water < 3) {
      click("补给交易");
      click("干草 ×3"); click("清水 ×3");
      const back = G.buttons().map(b => b.label).find(label => label?.startsWith("← 回到"));
      if (back) click(back);
    }
    if (G.state().stats.fodder <= 1) click("喂草安抚");
    // 疗伤：先用药膏，不够就去买
    if (G.state().stats.injury > 0) {
      if (G.state().stats.medicine > 0) click("诊治马匹");
      else {
        click("补给交易");
        click("药膏");
        const back = G.buttons().map((b) => b.label).find((l) => l && l.indexOf("← 回到") === 0);
        if (back) click(back);
        click("诊治马匹");
      }
    }
    click("歇一晚");
    click("继续赶路 →");
    continue;
  }
  fail.push("未知场景，无法推进：" + s.scene);
  break;
}

const st = G.state();
check(st.scene === "ending", "整局应能走到结局，实际停在：" + st.scene + "（第 " + legs + " 段）");
check(legs >= 20, "应至少走完 20 段路，实际 " + legs);
check(st.ending && st.ending.name, "结局对象应有名称");
check(st.stats.day > 20, "日程应随旅程推进，实际第 " + st.stats.day + " 天");
check(st.journal.length > 0, "旅志应记录内容");
check(Object.keys(st.seen).some(key => key.startsWith("sc:")), "满足条件的隐藏奇遇应实际触发并记录");
check(Number.isFinite(st.stats.stamina), "资源数值必须保持有限");

// 3. 结局页 → 旅志图鉴（确认两处绘制路径也不抛异常）
check(click("看看旅志"), "结局页应有「看看旅志」按钮");
check(G.state().scene === "codex", "点击后应进入旅志图鉴，实际：" + G.state().scene);
if (G.state().scene === "codex") {
  check(click("返回 (Esc)"), "旅志图鉴应有返回按钮");
  check(G.state().scene === "ending", "返回后应回到结局页，实际：" + G.state().scene);
}

console.log("—— 冒烟测试结果 ——");
console.log("走到结局：" + (st.ending ? st.ending.name : "无"));
console.log("路段数：" + legs + "  天数：" + st.stats.day + "  见闻：" + st.stats.insight);
console.log("羁绊：" + Math.round(st.stats.bond) + "  声望：" + st.stats.renown + "  银角：" + st.stats.coin);
console.log("旅志条数：" + st.journal.length + "  伤病：" + st.stats.injury);
console.log("羁绊轨迹：" + bondTrace.join(" → "));
if (fail.length) {
  console.error("\n❌ 失败 " + fail.length + " 项：");
  fail.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("\n✅ 全流程通过，无异常。");
