/**
 * 《长风万里》运行时引擎源码。
 *
 * 以字符串形式内联保存，原因有二：
 * 1. 编译器需要把它作为纯文本文件输出，浏览器端没有 fs；
 * 2. `demo/long-wind.html` 由同一份源码生成，保证「管线产出的游戏」与
 *    「仓库里能直接打开的游戏」永远一致。
 *
 * 约束：源码内不得出现反引号与 `${`，否则会与宿主模板字符串冲突。
 * 运行时解释 DATA（regions / nodes / events / quests / secrets / endings），并提供默认旅行规则。
 */
export const JOURNEY_ENGINE_JS = `(function () {
'use strict';

var DATA = window.__JOURNEY_DATA__ || {};
var REGIONS = DATA.regions || [];
var NODES = DATA.nodes || [];
var EVENTS = DATA.events || [];
var ENDINGS = DATA.endings || [];
var QUESTS = DATA.quests || [];
var SECRETS = DATA.secrets || [];
var START = DATA.start || {};

var W = 960, H = 540;
var GROUND_BASE = 430;
var PX_PER_LI = 40;
var LI_PER_DAY = 120;
var saveHash = 2166136261;
var saveSource = JSON.stringify(DATA);
for (var si = 0; si < saveSource.length; si++) saveHash = Math.imul(saveHash ^ saveSource.charCodeAt(si), 16777619);
var SAVE_KEY = 'journey.save.v2.' + (saveHash >>> 0).toString(16);

var canvas = document.getElementById('game');
var ctx = canvas.getContext('2d');
var dpr = Math.min(window.devicePixelRatio || 1, 2);

function resize() {
  var r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
}
window.addEventListener('resize', resize);

/* ---------------------------------------------------------------- 工具 */

function nz(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function num(v, d) { return typeof v === 'number' ? v : d; }

var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif';
function txt(s, x, y, size, color, align, weight) {
  ctx.font = (weight ? weight + ' ' : '') + size + 'px ' + FONT;
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color || '#f8fafc';
  ctx.fillText(s, x, y);
}
function wrap(s, x, y, maxW, lh, size, color, weight) {
  ctx.font = (weight ? weight + ' ' : '') + size + 'px ' + FONT;
  var line = '', yy = y;
  for (var i = 0; i < s.length; i++) {
    var test = line + s[i];
    if (ctx.measureText(test).width > maxW && line.length) {
      ctx.fillText(line, x, yy); yy += lh; line = s[i];
    } else { line = test; }
  }
  if (line.length) { ctx.fillText(line, x, yy); yy += lh; }
  return yy;
}
function rrect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function panel(x, y, w, h, fill, stroke) {
  ctx.fillStyle = fill || 'rgba(15,23,42,0.82)';
  rrect(x, y, w, h, 14); ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; rrect(x, y, w, h, 14); ctx.stroke(); }
}

var UI = [];
function btn(x, y, w, h, label, fn, opt) {
  opt = opt || {};
  UI.push({ x: x, y: y, w: w, h: h, fn: fn, label: label, disabled: !!opt.disabled });
  var hot = opt.hot;
  ctx.fillStyle = opt.disabled ? 'rgba(51,65,85,0.5)' : hot ? 'rgba(251,191,36,0.92)' : 'rgba(30,41,59,0.92)';
  rrect(x, y, w, h, 10); ctx.fill();
  ctx.strokeStyle = opt.disabled ? 'rgba(100,116,139,0.5)' : hot ? '#fbbf24' : 'rgba(148,163,184,0.55)';
  ctx.lineWidth = 1.5; rrect(x, y, w, h, 10); ctx.stroke();
  txt(label, x + w / 2, y + h / 2 + 5, opt.size || 17, opt.disabled ? '#94a3b8' : hot ? '#1f2937' : '#e2e8f0', 'center', '600');
  if (opt.sub) txt(opt.sub, x + w / 2, y + h - 9, 11, opt.disabled ? '#64748b' : hot ? '#78350f' : '#94a3b8', 'center');
}

/* ---------------------------------------------------------------- 音效 */

var AC = null, muted = false;
function ac() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = null; } }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
function tone(freq, dur, type, vol) {
  if (muted) return; var a = ac(); if (!a) return;
  var o = a.createOscillator(), g = a.createGain();
  o.type = type || 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, a.currentTime);
  g.gain.exponentialRampToValueAtTime(vol || 0.06, a.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
  o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + dur + 0.02);
}
function noise(dur, vol) {
  if (muted) return; var a = ac(); if (!a) return;
  var len = Math.floor(a.sampleRate * dur);
  var buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  var s = a.createBufferSource(), g = a.createGain(), f = a.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = 900;
  g.gain.value = vol || 0.05;
  s.buffer = buf; s.connect(f); f.connect(g); g.connect(a.destination); s.start();
}

/* ---------------------------------------------------------------- 状态 */

var S = null;
var toasts = [];

function toast(msg, color) { toasts.push({ msg: msg, t: 0, color: color || '#fde68a' }); if (toasts.length > 4) toasts.shift(); }

function freshStats() {
  return {
    coin: nz(START.coin, 60), fodder: nz(START.fodder, 6), water: nz(START.water, 6),
    stamina: nz(START.stamina, 100), vigor: nz(START.vigor, 100), bond: nz(START.bond, 20),
    insight: nz(START.insight, 0), renown: nz(START.renown, 0), guilt: nz(START.guilt, 0),
    day: nz(START.day, 1), medicine: nz(START.medicine, 1), injury: 0, cargo: 0, cargoCost: 0
  };
}

function newGame() {
  S = {
    scene: 'title', i: 0, stats: freshStats(), route: 'flat',
    journal: [], seen: {}, sketched: {}, flags: {}, dead: false,
    ride: null, nodeUi: null, event: null, ending: null, shake: 0, t: 0, hoofT: 0
  };
}

function save() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch (e) {} }
function load() {
  try {
    var raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    var o = JSON.parse(raw);
    if (!o || !o.stats) return false;
    S = o; if (!S.ride) S.ride = null; if (!S.journal) S.journal = []; return true;
  } catch (e) { return false; }
}
function hasSave() { try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; } }
function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }

function region() { var nd = NODES[Math.min(S.i, NODES.length - 1)]; return byId(REGIONS, nd ? nd.region : REGIONS[0].id) || REGIONS[0]; }
function byId(arr, id) { for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i]; return null; }
function node() { return NODES[Math.min(S.i, NODES.length - 1)]; }
function totalDistance() { var t = 0; for (var i = 0; i < NODES.length; i++) t += NODES[i].distance; return t; }

var ROUTES = [
  { id: 'flat', label: '平道', risk: 0.18, time: 1.15, desc: '好走，费时费粮' },
  { id: 'short', label: '捷径', risk: 0.45, time: 0.85, desc: '省一天，看运气' },
  { id: 'risky', label: '险路', risk: 0.8, time: 0.6, desc: '最快，最凶' }
];

function routes() {
  var custom = node() && node().routes;
  return custom && custom.length ? custom.map(function (route) { return { id: route.id, label: route.label, risk: route.risk, time: route.time, desc: '当前落脚点的路线' }; }) : ROUTES;
}

/* ------------------------------------------------------- 条件表达式求值 */

function evalCond(cond, vars) {
  if (!cond) return false;
  if (cond === 'true') return true;
  var orParts = cond.split('||');
  for (var i = 0; i < orParts.length; i++) {
    var andParts = orParts[i].split('&&');
    var ok = true;
    for (var j = 0; j < andParts.length; j++) {
      var p = andParts[j].trim();
      if (!p) continue;
      if (p === 'true') continue;
      var m = p.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\\s*(>=|<=|==|>|<)\\s*(-?[0-9.]+)$/);
      if (m) {
        var a = nz(vars[m[1]], 0), b = parseFloat(m[3]);
        if (m[2] === '>=' && !(a >= b)) ok = false;
        if (m[2] === '<=' && !(a <= b)) ok = false;
        if (m[2] === '==' && !(a === b)) ok = false;
        if (m[2] === '>' && !(a > b)) ok = false;
        if (m[2] === '<' && !(a < b)) ok = false;
      } else if (vars[p] === undefined) {
        ok = false;
      } else if (!vars[p]) {
        ok = false;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * 条件表达式的变量表：数值状态（stats）+ 派生统计。
 * 派生量让「完成过多少委托」「速写过几处」「走过几处风貌」都能当门槛用。
 */
function condVars() {
  var v = {}, k;
  for (k in S.stats) if (Object.prototype.hasOwnProperty.call(S.stats, k)) v[k] = S.stats[k];
  var q = 0, sc = 0, sk = 0, rg = 0;
  for (k in S.seen) {
    if (!S.seen[k]) continue;
    if (k.indexOf('q:') === 0) q++;
    else if (k.indexOf('sc:') === 0) sc++;
  }
  for (k in S.sketched) if (S.sketched[k]) sk++;
  for (var i = 0; i < REGIONS.length; i++) if (S.seen[REGIONS[i].id]) rg++;
  v.dead = S.dead; v.quests = q; v.secrets = sc; v.sketch = sk; v.regions = rg; v.journal = S.journal.length;
  return v;
}

function resolveEnding() {
  var vars = condVars();
  var out = null;
  for (var i = 0; i < ENDINGS.length; i++) {
    if (ENDINGS[i].id === 'lost') continue;
    if (evalCond(ENDINGS[i].condition, vars)) out = ENDINGS[i];
  }
  if (!out) out = byId(ENDINGS, 'homecoming') || ENDINGS[0];
  var lost = byId(ENDINGS, 'lost');
  if (lost && evalCond(lost.condition, vars)) out = lost;
  return out;
}

/* ---------------------------------------------------------------- 骑行 */

function startRide(routeId) {
  var nd = node();
  var r = byId(routes(), routeId) || routes()[0];
  S.route = r.id;
  var target = Math.max(600, Math.round(nd.distance * r.time * PX_PER_LI));
  S.ride = {
    dist: 0, target: target, gear: 1, jumpY: 0, vy: 0, grounded: true,
    obs: [], pick: [], threat: null, weather: pick(region().weather) || 'clear',
    spawnX: 620, pickX: 900, result: null, t: 0, days: 0, hoofT: 0
  };
  S.scene = 'ride';
  tone(392, 0.18, 'triangle', 0.05);
}

function groundY(wx) {
  var r = region();
  var amp = r.id === 'tiezhen' || r.id === 'cangmang' ? 34 : 18;
  return GROUND_BASE + Math.sin(wx * 0.0032) * amp + Math.sin(wx * 0.0011 + 1.7) * (amp * 0.6);
}

function jumpPower() { return 1 + (S.stats.bond >= 30 ? 0.12 : 0); }
function drainMul() {
  var m = region().drain;
  if (S.stats.bond >= 50) m *= 0.85;
  if (S.ride && S.ride.weather === 'sandstorm') m *= 1.35;
  if (S.ride && S.ride.weather === 'blizzard') m *= 1.2;
  if (S.stats.injury > 0) m *= 1.2;
  return m;
}
function hazardMul() { return S.stats.bond >= 70 ? 0.6 : 1; }

function spawnObstacle() {
  var r = region();
  var risk = (byId(routes(), S.route) || routes()[0]).risk;
  var isThreat = Math.random() < 0.22 + risk * 0.25;
  var x = S.ride.dist + 760 + Math.random() * 220;
  if (isThreat && r.hazards.length) {
    var th = r.hazards.filter(function (h) { return ['wolf', 'bandit', 'dune_maw', 'snow_leopard', 'vulture'].indexOf(h) >= 0; });
    var type = th.length ? pick(th) : pick(r.hazards);
    S.ride.obs.push({ x: x, type: type, threat: true, done: false });
  } else {
    var st = r.hazards.filter(function (h) { return ['fence', 'root', 'quicksand', 'rock', 'ice', 'tide', 'cliff', 'slick'].indexOf(h) >= 0; });
    var t2 = st.length ? pick(st) : 'rock';
    S.ride.obs.push({ x: x, type: t2, threat: false, done: false, h: t2 === 'cliff' ? 26 : 20 + Math.random() * 14 });
  }
}
function spawnPickup() {
  var r = Math.random();
  var type = r < 0.34 ? 'fodder' : r < 0.62 ? 'water' : r < 0.78 ? 'coin' : 'view';
  S.ride.pick.push({ x: S.ride.dist + 900 + Math.random() * 260, type: type, air: Math.random() < 0.35, done: false });
}

var THREATS = {
  wolf: { name: '灰狼群', act: '火把驱赶' },
  bandit: { name: '拦路盗匪', act: '好言交涉' },
  dune_maw: { name: '蚀沙虫', act: '投石引开' },
  snow_leopard: { name: '雪豹', act: '举火示警' },
  vulture: { name: '秃鹫', act: '挥鞭驱赶' }
};

function resolveThreat(choice) {
  var t = S.ride.threat; if (!t) return;
  var o = t.obj; var nm = (THREATS[o.type] || { name: '来敌' }).name;
  var ok = false, msg = '';
  if (choice === 0) {
    S.stats.stamina -= 8; S.stats.coin = Math.max(0, S.stats.coin - 3);
    ok = Math.random() < 0.72; msg = ok ? '你举起火把，' + nm + '退回了阴影里。' : '火把只亮了一瞬，' + nm + '扑了上来。';
  } else if (choice === 1) {
    S.stats.stamina -= 18; S.stats.vigor -= 5;
    ok = Math.random() < 0.85; msg = ok ? '你伏低身子疾驰，把' + nm + '甩在了身后。' : '马腿一软，你被' + nm + '追上了。';
  } else {
    S.stats.vigor -= 18; S.stats.renown += 1; S.stats.insight += 2; S.stats.bond += 2;
    ok = Math.random() < 0.6; msg = ok ? '你正面迎上去，' + nm + '退了。路上的人都记住了你。' : '一场恶斗，你赢了，但血也流了不少。';
    S.stats.injury += ok ? 0 : 1;
  }
  if (!ok) { S.stats.stamina -= 14; S.stats.injury += 1; S.stats.bond -= 1; }
  else { S.stats.bond += 2; }
  toast(msg, ok ? '#bbf7d0' : '#fecaca');
  S.journal.push(nm + '：' + msg);
  o.done = true; S.ride.threat = null;
  tone(ok ? 523 : 196, 0.22, 'triangle', 0.05);
  clampAll();
}

function hitHazard(o) {
  var dmg = 12 * hazardMul();
  S.stats.stamina -= dmg; S.stats.vigor -= 8 * hazardMul(); S.stats.bond -= 1;
  S.shake = 0.35; S.ride.hits = (S.ride.hits || 0) + 1;
  if (Math.random() < 0.08) { S.stats.injury += 1; toast('马腿一别，蹄子有些瘸了。', '#fca5a5'); }
  else toast('没能跃过去，人马都震了一下。', '#fca5a5');
  tone(120, 0.2, 'sawtooth', 0.06);
  noise(0.12, 0.06);
  o.done = true;
  clampAll();
}

function clampAll() {
  var s = S.stats;
  s.stamina = clamp(s.stamina, 0, 100);
  s.vigor = clamp(s.vigor, 0, 100);
  s.bond = clamp(s.bond, 0, 100);
  s.insight = Math.max(0, s.insight);
  s.renown = clamp(s.renown, 0, 40);
  s.guilt = Math.max(0, s.guilt);
  s.injury = clamp(s.injury, 0, 3);
  s.fodder = Math.max(0, s.fodder); s.water = Math.max(0, s.water);
  s.coin = Math.max(0, s.coin); s.medicine = Math.max(0, s.medicine);
}

function applyEffects(eff) {
  if (!eff) return;
  var msgs = [];
  for (var k in eff) {
    if (!Object.prototype.hasOwnProperty.call(eff, k)) continue;
    var v = eff[k];
    if (k === 'day') S.stats.day += v;
    else if (S.stats[k] === undefined) S.stats[k] = v;
    else S.stats[k] += v;
    msgs.push(labelOf(k) + (v > 0 ? ' +' : ' ') + v);
  }
  clampAll();
  return msgs.join('  ');
}
function labelOf(k) {
  return ({ coin: '银角', fodder: '干草', water: '清水', stamina: '体力', vigor: '精力', bond: '羁绊', insight: '见闻', renown: '声望', guilt: '负疚', day: '日程', medicine: '药膏', injury: '伤病', cargo: '货物' })[k] || k;
}

/* ---------------------------------------------------------------- 节点 */

function arriveNode() {
  var rt = byId(routes(), S.route) || routes()[0];
  var days = Math.max(1, Math.round(node().distance * rt.time / LI_PER_DAY));
  S.ride.days = days;
  S.stats.day += days;
  for (var d = 0; d < days; d++) {
    if (S.stats.fodder > 0) S.stats.fodder -= 1; else { S.stats.stamina -= 18; S.stats.bond -= 3; toast('干草见底，马饿得发抖。', '#fca5a5'); }
    if (S.stats.water > 0) S.stats.water -= 1; else { S.stats.vigor -= 18; toast('水囊空了，你头晕得厉害。', '#fca5a5'); }
  }
  if (!S.ride.hits) { S.stats.bond += 2; }
  if (S.stats.stamina <= 0 && S.stats.injury >= 3) { S.dead = true; finish(); return; }
  S.stats.stamina = clamp(S.stats.stamina + 16, 0, 100);
  S.stats.vigor = clamp(S.stats.vigor + 10, 0, 100);
  clampAll();

  S.i += 1;
  if (S.i >= NODES.length) { finish(); return; }

  var nd = node(), rg = region();
  if (!S.seen[rg.id]) { S.seen[rg.id] = true; S.stats.insight += 4; S.journal.push('初入' + rg.name + '，你记下了第一笔风物。'); }

  S.nodeUi = { shop: false, msg: '' };
  S.scene = 'node';
  save();
  maybeEvent();
}

function maybeEvent() {
  var rg = region();
  var secret = SECRETS.find(function (e) {
    return !S.seen['sc:' + e.id] && (!e.region || e.region === rg.id) && (!e.requires || evalCond(e.requires, condVars()));
  });
  if (secret) { S.event = { def: secret, result: null, kind: 'secret', returnScene: 'node' }; S.scene = 'event'; return; }
  var pool = EVENTS.filter(function (e) {
    if (e.id === 'ev_start') return false;
    if (S.seen['ev:' + e.id]) return false;
    if (e.region && e.region !== rg.id) return false;
    return true;
  });
  if (!pool.length) return;
  var total = 0, i;
  for (i = 0; i < pool.length; i++) total += Math.max(1, pool[i].weight);
  var r = Math.random() * total, acc = 0, chosen = pool[0];
  for (i = 0; i < pool.length; i++) { acc += Math.max(1, pool[i].weight); if (r <= acc) { chosen = pool[i]; break; } }
  S.event = { def: chosen, result: null, kind: 'event', returnScene: 'node' };
  S.scene = 'event';
}

function chooseEvent(idx) {
  var e = S.event; if (!e || e.result) return;
  var c = e.def.choices[idx]; if (!c) return;
  if (c.requires && !evalCond(c.requires, condVars())) return;
  var delta = applyEffects(c.effects);
  S.seen[(e.kind === 'quest' ? 'q:' : e.kind === 'secret' ? 'sc:' : 'ev:') + e.def.id] = true;
  S.journal.push(e.def.title + '｜' + c.label + (c.log ? '：' + c.log : ''));
  e.result = { log: c.log || '你做了选择。', delta: delta };
  save();
  tone(587, 0.25, 'sine', 0.05);
}

function nextLeg() {
  var returnScene = S.event && S.event.returnScene || 'map';
  S.event = null;
  S.scene = returnScene;
  if (returnScene === 'node' && !S.nodeUi) S.nodeUi = { shop: false, msg: '' };
  save();
}

function finish() {
  S.ending = resolveEnding();
  S.scene = 'ending';
  clearSave();
  tone(523, 0.5, 'sine', 0.05);
  setTimeout(function () { tone(659, 0.6, 'sine', 0.04); }, 260);
}

function shopItems() {
  var rg = region();
  var mult = 1 + (S.i / NODES.length) * 0.8;
  var saltPrice = rg.id === 'yunling' ? 14 : rg.id === 'chisha' ? 5 : 8;
  return [
    { key: 'fodder', name: '干草 ×3', cost: Math.round(9 * mult), run: function () { S.stats.fodder += 3; } },
    { key: 'water', name: '清水 ×3', cost: Math.round(9 * mult), run: function () { S.stats.water += 3; } },
    { key: 'medicine', name: '药膏', cost: Math.round(14 * mult), run: function () { S.stats.medicine += 1; } },
    { key: 'shoe', name: '钉蹄铁', cost: Math.round(16 * mult), run: function () { S.stats.injury = Math.max(0, S.stats.injury - 1); S.stats.bond += 2; } },
    { key: 'salt', name: '海盐 ×10', cost: Math.round(7 * mult * 10), run: function () { S.stats.cargo += 10; S.stats.cargoCost += Math.round(7 * mult * 10); } }
  ];
}
function sellSalt() {
  var rg = region();
  var price = rg.id === 'yunling' ? 14 : rg.id === 'chisha' ? 5 : 8;
  if (S.stats.cargo <= 0) return;
  var gain = S.stats.cargo * price;
  S.stats.coin += gain; S.stats.cargo = 0; S.stats.cargoCost = 0;
  S.stats.renown += 1;
  toast('盐卖出去了，进账 ' + gain + ' 银角。', '#bbf7d0');
  S.journal.push('在' + rg.name + '卖掉了盐，得 ' + gain + ' 银角。');
  tone(659, 0.2, 'sine', 0.05);
}

/* ---------------------------------------------------------------- 输入 */

var keys = {};
window.addEventListener('keydown', function (e) {
  if (keys[e.code]) return;
  keys[e.code] = true;
  ac();
  onKey(e.code);
});
window.addEventListener('keyup', function (e) { keys[e.code] = false; });

function onKey(code) {
  if (code === 'KeyM') { muted = !muted; toast(muted ? '已静音' : '声音开启', '#93c5fd'); return; }
  if (S.scene === 'title') {
    if (code === 'Enter' || code === 'Space') { if (hasSave()) load(); else { newGame(); S.scene = 'map'; introEvent(); } }
    if (code === 'KeyR' && hasSave()) { clearSave(); newGame(); S.scene = 'map'; introEvent(); }
    return;
  }
  if (S.scene === 'ride') {
    if (S.ride.threat && /^Digit[123]$/.test(code)) { resolveThreat(Number(code.slice(-1)) - 1); return; }
    if (code === 'Space' || code === 'KeyW' || code === 'ArrowUp') jump();
    if (code === 'Digit1') setGear(0);
    if (code === 'Digit2') setGear(1);
    if (code === 'Digit3') setGear(2);
    if (code === 'ArrowLeft' || code === 'KeyA' || code === 'KeyS' || code === 'ArrowDown') setGear(S.ride.gear - 1);
    if (code === 'ArrowRight' || code === 'KeyD') setGear(S.ride.gear + 1);
    if (code === 'KeyC') { openCodex(); }
    return;
  }
  if (S.scene === 'map') {
    if (/^Digit[123]$/.test(code)) { var selectedRoute = routes()[Number(code.slice(-1)) - 1]; if (selectedRoute) startRide(selectedRoute.id); }
    if (code === 'KeyC') { openCodex(); }
    return;
  }
  if (S.scene === 'codex' && (code === 'KeyC' || code === 'Escape')) { leaveCodex(); return; }
  if (S.scene === 'event') {
    if (S.event.result) { if (code === 'Enter' || code === 'Space') nextLeg(); return; }
    if (code === 'Digit1') chooseEvent(0);
    if (code === 'Digit2') chooseEvent(1);
    if (code === 'Digit3') chooseEvent(2);
    return;
  }
  if (S.scene === 'ending' && (code === 'Enter' || code === 'Space')) { newGame(); }
}

function introEvent() {
  var e = byId(EVENTS, 'ev_start');
  if (e) { S.event = { def: e, result: null, kind: 'event', returnScene: 'map' }; S.scene = 'event'; }
}

function setGear(g) { if (!S.ride) return; S.ride.gear = clamp(g, 0, 2); }
function jump() {
  if (!S.ride || !S.ride.grounded) return;
  S.ride.vy = 700 * jumpPower(); S.ride.grounded = false;
  tone(660, 0.12, 'square', 0.04);
}

canvas.addEventListener('pointerdown', function (e) {
  ac();
  var r = canvas.getBoundingClientRect();
  var x = (e.clientX - r.left) / r.width * W, y = (e.clientY - r.top) / r.height * H;
  for (var i = UI.length - 1; i >= 0; i--) {
    var b = UI[i];
    if (!b.disabled && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { b.fn(); return; }
  }
  if (S && S.scene === 'ride') jump();
  else if (S && S.scene === 'event' && S.event.result) nextLeg();
  else if (S && S.scene === 'title') { if (hasSave()) load(); else { newGame(); S.scene = 'map'; introEvent(); } }
});

/* ---------------------------------------------------------------- 更新 */

var last = 0;
function loop(ts) {
  var dt = Math.min(0.05, (ts - last) / 1000 || 0); last = ts;
  update(dt); render(dt);
  requestAnimationFrame(loop);
}

function update(dt) {
  if (!S) return;
  S.t += dt;
  for (var i = toasts.length - 1; i >= 0; i--) { toasts[i].t += dt; if (toasts[i].t > 3) toasts.splice(i, 1); }
  if (S.shake > 0) S.shake = Math.max(0, S.shake - dt * 1.2);
  if (S.scene === 'ride') updateRide(dt);
}

function updateRide(dt) {
  var r = S.ride, rg = region(), s = S.stats;
  r.t += dt;
  if (r.threat) return;

  if (s.stamina <= 0 && !r.exhausted) {
    r.exhausted = true;
    s.day += 1;
    if (s.fodder > 0) s.fodder -= 1; else s.bond -= 4;
    if (s.water > 0) s.water -= 1; else s.vigor -= 12;
    s.stamina = 60; s.vigor = clamp(s.vigor + 10, 0, 100);
    r.gear = 0;
    toast('马再也走不动了。你就地扎营，多耗了一天。', '#fca5a5');
    S.journal.push('在' + rg.name + '力竭扎营一日。');
    clampAll(); save();
    tone(196, 0.4, 'sine', 0.05);
  }
  if (s.stamina > 45) r.exhausted = false;

  var base = [70, 135, 210][r.gear];
  var sp = base * rg.speed;
  if (s.stamina <= 0) sp *= 0.55;
  else if (s.stamina < 25) sp *= 0.75;
  if (s.injury > 0) sp *= Math.max(0.82, 1 - 0.06 * s.injury);
  if (r.weather === 'sandstorm' || r.weather === 'blizzard') sp *= 0.8;
  if (S.stats.bond >= 50) sp *= 1.05;

  r.dist += sp * dt;

  var drain = [0.2, 0.55, 1.2][r.gear] * drainMul();
  s.stamina -= drain * dt;
  s.vigor -= drain * 0.35 * dt;
  clampAll();

  if (!r.grounded) {
    r.vy -= 1300 * dt; r.jumpY += r.vy * dt;
    if (r.jumpY <= 0) { r.jumpY = 0; r.vy = 0; r.grounded = true; noise(0.08, 0.04); }
  }

  r.hoofT -= dt;
  if (r.hoofT <= 0) { r.hoofT = 0.42 - r.gear * 0.11; if (r.grounded) noise(0.05, 0.012 + r.gear * 0.008); }

  while (r.spawnX < r.dist + 1100) { spawnObstacle(); r.spawnX += 520 + Math.random() * 520 - (byId(ROUTES, S.route).risk * 160); }
  while (r.pickX < r.dist + 1200) { spawnPickup(); r.pickX += 420 + Math.random() * 380; }

  var hx = r.dist + 300;
  for (var i = 0; i < r.obs.length; i++) {
    var o = r.obs[i];
    if (o.done) continue;
    if (o.threat && Math.abs(o.x - hx) < 40) { r.threat = { obj: o }; tone(220, 0.25, 'sawtooth', 0.05); continue; }
    if (Math.abs(o.x - hx) < 38 && r.jumpY < (o.h || 22) + 6) hitHazard(o);
    else if (o.x < hx - 120) o.done = true;
  }
  for (var j = 0; j < r.pick.length; j++) {
    var p = r.pick[j];
    if (p.done) continue;
    var py = groundY(p.x) - (p.air ? 90 : 26);
    if (Math.abs(p.x - hx) < 44 && Math.abs(py - (groundY(hx) - 40 - r.jumpY)) < 60) {
      p.done = true;
      if (p.type === 'fodder') { s.fodder += 1; toast('拾得干草 +1', '#bbf7d0'); }
      else if (p.type === 'water') { s.water += 1; toast('灌满水囊 +1', '#bbf7d0'); }
      else if (p.type === 'coin') { s.coin += 6; toast('路上捡到 6 银角', '#fde68a'); }
      else {
        s.insight += 2; toast('速写：' + rg.name + '的一角（见闻 +2）', '#fde68a');
        S.sketched[rg.id] = (S.sketched[rg.id] || 0) + 1;
      }
      tone(880, 0.1, 'sine', 0.04);
    } else if (p.x < hx - 140) p.done = true;
  }

  if (r.dist >= r.target) arriveNode();
}

/* ---------------------------------------------------------------- 绘制 */

function render() {
  UI.length = 0;
  if (!S) return;
  ctx.save();
  if (S.shake > 0) ctx.translate((Math.random() - 0.5) * 10 * S.shake, (Math.random() - 0.5) * 10 * S.shake);
  if (S.scene === 'title') drawTitle();
  else if (S.scene === 'map') drawMap();
  else if (S.scene === 'ride') { drawRide(); drawHud(); if (S.ride.threat) drawThreat(); }
  else if (S.scene === 'node') { drawRideBackdrop(true); drawNode(); }
  else if (S.scene === 'event') { drawRideBackdrop(true); drawEvent(); }
  else if (S.scene === 'codex') { drawRideBackdrop(true); drawCodex(); }
  else if (S.scene === 'ending') drawEnding();
  ctx.restore();
  drawToasts();
  if (S.scene === 'ride') drawMobile();
}

function drawToasts() {
  for (var i = 0; i < toasts.length; i++) {
    var t = toasts[i];
    var a = clamp(Math.min(t.t * 4, (3 - t.t) * 2), 0, 1);
    ctx.globalAlpha = a;
    panel(W / 2 - 190, 96 + i * 34, 380, 28, 'rgba(15,23,42,0.8)');
    txt(t.msg, W / 2, 115 + i * 34, 14, t.color, 'center');
    ctx.globalAlpha = 1;
  }
}

var TITLE_T = 0;
function drawTitle() {
  TITLE_T += 0.01;
  var g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0b1a2b'); g.addColorStop(1, '#3a2c1d');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  for (var i = 0; i < 60; i++) {
    var x = (i * 137.5 + TITLE_T * 40) % W, y = (i * 71.3) % 300;
    ctx.fillStyle = 'rgba(253,230,138,' + (0.15 + 0.25 * Math.abs(Math.sin(i + TITLE_T))) + ')';
    ctx.fillRect(x, y, 2, 2);
  }
  txt(document.title || '长风万里', W / 2, 168, 58, '#fde68a', 'center', '700');
  txt('THE  LONG  WIND', W / 2, 200, 15, '#94a3b8', 'center');
  txt('一匹马，一本残缺的游记，一条绕世界一圈的路', W / 2, 246, 17, '#cbd5e1', 'center');

  panel(W / 2 - 300, 280, 600, 132, 'rgba(15,23,42,0.55)', 'rgba(148,163,184,0.25)');
  txt('操作', W / 2, 306, 15, '#fbbf24', 'center', '600');
  txt('空格 / ↑ / 点击 = 跃障      1 2 3 或 ← → = 漫步 / 小跑 / 疾驰', W / 2 - 270, 332, 14, '#cbd5e1');
  txt('C = 旅志图鉴      M = 静音      移动端：右下角三键', W / 2 - 270, 356, 14, '#cbd5e1');
  txt('路上要做选择：走哪条路、救不救人、给不给钱——它们都会写进你的游记。', W / 2 - 270, 384, 14, '#94a3b8');

  btn(W / 2 - 150, 434, 140, 46, hasSave() ? '继续旅程' : '上马出发', function () {
    if (hasSave()) load(); else { newGame(); S.scene = 'map'; introEvent(); }
  }, { hot: true });
  if (hasSave()) btn(W / 2 + 10, 434, 140, 46, '重新开始', function () { clearSave(); newGame(); S.scene = 'map'; introEvent(); });
}

function drawMap() {
  var g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0f172a'); g.addColorStop(1, '#1e293b');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  txt('舆 图 · 选择下一段路', W / 2, 48, 26, '#fde68a', 'center', '700');
  var nd = node(), rg = region();
  txt('当前：' + nd.name + '（' + rg.name + '）', W / 2, 76, 15, '#cbd5e1', 'center');

  var cx = W / 2, cy = 250, R = 150;
  for (var i = 0; i < NODES.length; i++) {
    var a = -Math.PI / 2 + (i / NODES.length) * Math.PI * 2;
    var x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R * 0.78;
    var done = i < S.i, cur = i === S.i;
    var rr = regionOf(NODES[i]);
    ctx.beginPath(); ctx.arc(x, y, cur ? 9 : 5, 0, 6.283);
    ctx.fillStyle = cur ? '#fbbf24' : done ? 'rgba(148,163,184,0.7)' : (rr ? rr.palette[2] : '#64748b');
    ctx.fill();
    if (cur) { ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 15, 0, 6.283); ctx.stroke(); }
  }
  ctx.strokeStyle = 'rgba(148,163,184,0.25)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(cx, cy, R, R * 0.78, 0, 0, 6.283); ctx.stroke();

  var next = NODES[Math.min(S.i + 1, NODES.length - 1)];
  var isLast = S.i >= NODES.length - 1;
  txt(isLast ? '前方便是柳湾村 —— 绕完这一圈，就该回家了。' : '下一段：' + nd.name + ' → ' + next.name, W / 2, 96, 14, '#94a3b8', 'center');

  var availableRoutes = routes();
  for (var k = 0; k < Math.min(3, availableRoutes.length); k++) {
    var r = availableRoutes[k];
    var bw = 250, bx = W / 2 - 400 + k * (bw + 25), by = 380;
    var days = Math.max(1, Math.round(nd.distance * r.time / LI_PER_DAY));
    btn(bx, by, bw, 96, r.label, (function (id) { return function () { startRide(id); }; })(r.id), {
      hot: k === 1, disabled: false
    });
    txt(r.label, bx + bw / 2, by + 32, 24, k === 1 ? '#1f2937' : '#e2e8f0', 'center', '700');
    txt(r.desc, bx + bw / 2, by + 56, 13, k === 1 ? '#78350f' : '#94a3b8', 'center');
    txt('约 ' + days + ' 天 · 风险 ' + Math.round(r.risk * 100) + '%', bx + bw / 2, by + 78, 13, k === 1 ? '#78350f' : '#64748b', 'center');
  }

  btn(W / 2 - 260, 492, 150, 34, '落脚休整', function () { S.nodeUi = S.nodeUi || { shop: false, msg: '' }; S.scene = 'node'; });
  btn(W / 2 - 60, 492, 120, 34, '旅志图鉴 (C)', function () { openCodex(); });
}
function regionOf(nd) { return byId(REGIONS, nd.region); }

/* ---- 场景绘制 ---- */

function drawRideBackdrop(staticBg) {
  var rg = region();
  var g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rg.palette[0]); g.addColorStop(1, rg.palette[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  var off = staticBg ? (S.ride ? S.ride.dist : 0) : S.ride.dist;
  drawRidge(off * 0.12, 300, 90, rg.palette[2], 0.35, 0.004);
  drawRidge(off * 0.28, 350, 60, rg.palette[2], 0.55, 0.007);

  ctx.fillStyle = rg.palette[2];
  ctx.beginPath(); ctx.moveTo(0, H);
  for (var x = 0; x <= W; x += 12) ctx.lineTo(x, groundY(off + x));
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();

  ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 3;
  ctx.beginPath();
  for (var x2 = 0; x2 <= W; x2 += 12) { var y2 = groundY(off + x2); if (x2 === 0) ctx.moveTo(x2, y2); else ctx.lineTo(x2, y2); }
  ctx.stroke();

  drawFlora(off, rg);
  drawWeather(rg, staticBg);
}

function drawRidge(off, baseY, amp, color, alpha, freq) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(0, H);
  for (var x = 0; x <= W; x += 16) {
    var y = baseY + Math.sin((x + off) * freq) * amp + Math.sin((x + off) * freq * 2.3) * amp * 0.35;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
}

function drawFlora(off, rg) {
  var step = 190;
  var start = Math.floor(off / step) * step;
  for (var i = 0; i < 8; i++) {
    var wx = start + i * step;
    var sx = wx - off;
    if (sx < -60 || sx > W + 60) continue;
    var y = groundY(wx);
    var seed = (wx % 997) / 997;
    ctx.save(); ctx.translate(sx, y);
    if (rg.id === 'qingwu') { ctx.fillStyle = '#3f7d33'; ctx.fillRect(-3, -26 * (0.7 + seed), 6, 26 * (0.7 + seed)); ctx.fillStyle = '#5fa34a'; ctx.beginPath(); ctx.ellipse(0, -30 * (0.7 + seed), 12, 7, 0, 0, 6.283); ctx.fill(); }
    else if (rg.id === 'baihua') { ctx.fillStyle = '#e8eef0'; ctx.fillRect(-5, -70 * (0.8 + seed * 0.4), 10, 70); ctx.fillStyle = '#2f6b34'; ctx.beginPath(); ctx.arc(0, -74 * (0.8 + seed * 0.4), 16, 0, 6.283); ctx.fill(); }
    else if (rg.id === 'chisha') { ctx.fillStyle = '#b8862f'; ctx.beginPath(); ctx.moveTo(-16, 0); ctx.quadraticCurveTo(0, -50 * (0.6 + seed), 16, 0); ctx.closePath(); ctx.fill(); }
    else if (rg.id === 'tiezhen') { ctx.fillStyle = '#6b5b4a'; ctx.beginPath(); ctx.moveTo(-22, 0); ctx.lineTo(-8, -46 * (0.6 + seed)); ctx.lineTo(10, -30 * (0.6 + seed)); ctx.lineTo(24, 0); ctx.closePath(); ctx.fill(); }
    else if (rg.id === 'yunling') { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.ellipse(0, -8, 30, 12, 0, 0, 6.283); ctx.fill(); }
    else if (rg.id === 'canglan') { ctx.strokeStyle = '#8fa06a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(6 * seed, -34, -8, -58); ctx.stroke(); }
    else { ctx.fillStyle = '#7a6a55'; ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(0, -30 * (0.7 + seed)); ctx.lineTo(16, 0); ctx.closePath(); ctx.fill(); }
    ctx.restore();
  }
}

function drawWeather(rg, allowStorm) {
  var w = S.ride ? S.ride.weather : 'clear';
  if (w === 'clear') return;
  if (w === 'rain') {
    ctx.strokeStyle = 'rgba(174,194,224,0.55)'; ctx.lineWidth = 1.5;
    for (var i = 0; i < 90; i++) {
      var x = (i * 97 + S.t * 900) % (W + 60) - 30, y = (i * 53 + S.t * 1400) % H;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 6, y + 18); ctx.stroke();
    }
  } else if (w === 'sandstorm') {
    ctx.fillStyle = 'rgba(217,164,65,0.35)'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,236,190,0.35)';
    for (var j = 0; j < 60; j++) {
      var x2 = (j * 131 + S.t * 1600) % (W + 80) - 40, y2 = (j * 71) % H;
      ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - 40, y2 + 4); ctx.stroke();
    }
  } else if (w === 'blizzard') {
    ctx.fillStyle = 'rgba(226,232,240,0.28)'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (var k = 0; k < 70; k++) {
      var x3 = (k * 113 + Math.sin(S.t + k) * 40 + S.t * 260) % W, y3 = (k * 59 + S.t * 320) % H;
      ctx.beginPath(); ctx.arc(x3, y3, 2.4, 0, 6.283); ctx.fill();
    }
  } else if (w === 'fog') {
    ctx.fillStyle = 'rgba(203,213,225,0.34)'; ctx.fillRect(0, 0, W, H);
  } else if (w === 'gale') {
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 2;
    for (var m = 0; m < 26; m++) {
      var y4 = (m * 41 + S.t * 60) % H, x4 = (m * 211 + S.t * 1800) % (W + 200) - 100;
      ctx.beginPath(); ctx.moveTo(x4, y4); ctx.lineTo(x4 + 90, y4 + 6); ctx.stroke();
    }
  } else if (w === 'heat') {
    ctx.fillStyle = 'rgba(251,146,60,0.12)'; ctx.fillRect(0, 0, W, H);
  } else if (w === 'tide') {
    ctx.fillStyle = 'rgba(56,189,248,0.18)'; ctx.fillRect(0, GROUND_BASE + 30, W, H - GROUND_BASE - 30);
  } else if (w === 'rockfall') {
    ctx.fillStyle = 'rgba(120,113,108,0.9)';
    for (var q = 0; q < 4; q++) {
      var rx = (q * 260 + 120) % W, ry = ((S.t * 420 + q * 180) % (H + 80)) - 40;
      ctx.beginPath(); ctx.arc(rx, ry, 6, 0, 6.283); ctx.fill();
    }
  }
}

function drawRide() {
  drawRideBackdrop(false);
  var r = S.ride, off = r.dist;

  for (var i = 0; i < r.pick.length; i++) {
    var p = r.pick[i]; if (p.done) continue;
    var sx = p.x - off; if (sx < -40 || sx > W + 40) continue;
    var py = groundY(p.x) - (p.air ? 90 : 26);
    ctx.save(); ctx.translate(sx, py + Math.sin(S.t * 3 + p.x) * 3);
    if (p.type === 'fodder') { ctx.fillStyle = '#e3b23c'; ctx.fillRect(-10, -8, 20, 16); ctx.strokeStyle = '#8a6a1d'; ctx.strokeRect(-10, -8, 20, 16); }
    else if (p.type === 'water') { ctx.fillStyle = '#38bdf8'; ctx.beginPath(); ctx.arc(0, 0, 9, 0, 6.283); ctx.fill(); ctx.strokeStyle = '#0369a1'; ctx.stroke(); }
    else if (p.type === 'coin') { ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(0, 0, 8, 0, 6.283); ctx.fill(); ctx.strokeStyle = '#b45309'; ctx.stroke(); }
    else { ctx.fillStyle = 'rgba(253,224,71,0.9)'; ctx.beginPath(); ctx.arc(0, 0, 12 + Math.sin(S.t * 4) * 2, 0, 6.283); ctx.fill(); ctx.fillStyle = '#78350f'; txt('景', 0, 5, 12, '#78350f', 'center', '700'); }
    ctx.restore();
  }

  for (var j = 0; j < r.obs.length; j++) {
    var o = r.obs[j]; if (o.done) continue;
    var ox = o.x - off; if (ox < -80 || ox > W + 80) continue;
    var oy = groundY(o.x);
    ctx.save(); ctx.translate(ox, oy);
    if (o.threat) {
      var bob = Math.sin(S.t * 6 + o.x) * 3;
      ctx.fillStyle = o.type === 'vulture' ? '#475569' : o.type === 'snow_leopard' ? '#e2e8f0' : o.type === 'dune_maw' ? '#a16207' : o.type === 'bandit' ? '#7f1d1d' : '#4b5563';
      ctx.beginPath(); ctx.ellipse(0, -18 + bob, 20, 13, 0, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(20, -26 + bob, 8, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#fca5a5'; ctx.fillRect(24, -28 + bob, 3, 3);
      ctx.fillStyle = 'rgba(248,113,113,0.9)';
      txt('！', 0, -44 + bob, 22, '#f87171', 'center', '700');
    } else {
      if (o.type === 'fence') { ctx.fillStyle = '#8b5a2b'; ctx.fillRect(-4, -34, 8, 34); ctx.fillRect(-26, -28, 52, 6); ctx.fillRect(-26, -14, 52, 6); }
      else if (o.type === 'root') { ctx.fillStyle = '#6b4a2a'; ctx.beginPath(); ctx.moveTo(-30, 0); ctx.quadraticCurveTo(0, -30, 30, 0); ctx.closePath(); ctx.fill(); }
      else if (o.type === 'quicksand') { ctx.fillStyle = '#c9a227'; ctx.beginPath(); ctx.ellipse(0, 2, 34, 10, 0, 0, 6.283); ctx.fill(); ctx.fillStyle = '#a16207'; ctx.beginPath(); ctx.arc(0, 0, 8, 0, 6.283); ctx.fill(); }
      else if (o.type === 'ice') { ctx.fillStyle = '#93c5fd'; ctx.beginPath(); ctx.moveTo(-26, 4); ctx.lineTo(0, -18); ctx.lineTo(26, 4); ctx.closePath(); ctx.fill(); }
      else if (o.type === 'cliff') { ctx.fillStyle = '#57534e'; ctx.fillRect(-30, -8, 30, 10); ctx.fillRect(14, -8, 30, 10); }
      else if (o.type === 'tide') { ctx.fillStyle = 'rgba(14,165,233,0.8)'; ctx.beginPath(); ctx.ellipse(0, 4, 40, 12, 0, 0, 6.283); ctx.fill(); }
      else { ctx.fillStyle = '#6b7280'; ctx.beginPath(); ctx.moveTo(-20, 2); ctx.lineTo(-10, -(o.h || 22)); ctx.lineTo(6, -(o.h || 22)); ctx.lineTo(20, 2); ctx.closePath(); ctx.fill(); }
      if (S.stats.bond >= 90) { ctx.strokeStyle = 'rgba(251,191,36,0.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, -52); ctx.lineTo(-7, -38); ctx.lineTo(7, -38); ctx.closePath(); ctx.stroke(); }
    }
    ctx.restore();
  }

  drawHorse(300, groundY(r.dist + 300) - r.jumpY, r);
}

function drawHorse(x, y, r) {
  var sp = [70, 135, 210][r.gear] * region().speed;
  var ph = S.t * (5 + sp * 0.02);
  var bob = r.grounded ? Math.sin(ph) * (1 + r.gear * 1.2) : 0;
  var lean = -0.06 - r.gear * 0.05;

  ctx.save();
  ctx.translate(x, y + bob);
  ctx.rotate(lean * 0.25);

  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath(); ctx.ellipse(0, 4, 44, 7, 0, 0, 6.283); ctx.fill();

  var body = '#c8a165', dark = '#8f6d3f';
  ctx.strokeStyle = dark; ctx.lineWidth = 6; ctx.lineCap = 'round';
  for (var i = 0; i < 4; i++) {
    var a = Math.sin(ph + i * 1.7) * (0.35 + r.gear * 0.32);
    var lx = i < 2 ? 20 : -20;
    ctx.beginPath();
    ctx.moveTo(lx, -26);
    ctx.lineTo(lx + Math.sin(a) * 16, -26 + Math.cos(a) * 14);
    ctx.lineTo(lx + Math.sin(a) * 22, r.grounded ? -2 : -8);
    ctx.stroke();
  }

  ctx.fillStyle = body;
  ctx.beginPath(); ctx.ellipse(0, -34, 34, 17, 0, 0, 6.283); ctx.fill();
  ctx.beginPath(); ctx.moveTo(22, -44); ctx.quadraticCurveTo(40, -62, 46, -74); ctx.lineTo(58, -70); ctx.quadraticCurveTo(48, -56, 34, -38); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.ellipse(56, -76, 11, 7, -0.5, 0, 6.283); ctx.fill();
  ctx.fillStyle = dark;
  ctx.beginPath(); ctx.moveTo(46, -80); ctx.lineTo(44, -88); ctx.lineTo(50, -84); ctx.closePath(); ctx.fill();

  ctx.strokeStyle = dark; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(-32, -38);
  ctx.quadraticCurveTo(-52, -34 - Math.sin(ph) * 8, -60, -18 - Math.sin(ph) * 6);
  ctx.stroke();

  ctx.fillStyle = '#7a5a2e';
  ctx.beginPath(); ctx.ellipse(6, -46, 20, 8, 0, 0, 6.283); ctx.fill();

  ctx.save();
  ctx.translate(2, -52);
  ctx.fillStyle = '#1f2937';
  ctx.beginPath(); ctx.ellipse(0, -14, 8, 15, 0, 0, 6.283); ctx.fill();
  ctx.fillStyle = '#d9a066';
  ctx.beginPath(); ctx.arc(1, -32, 8, 0, 6.283); ctx.fill();
  ctx.fillStyle = '#7c2d12';
  ctx.beginPath(); ctx.moveTo(-11, -36); ctx.lineTo(13, -36); ctx.lineTo(1, -46); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(4, -18); ctx.lineTo(34, -44); ctx.stroke();
  var flap = Math.sin(ph * 0.8) * 6;
  ctx.fillStyle = 'rgba(180,83,9,0.9)';
  ctx.beginPath(); ctx.moveTo(-6, -20); ctx.quadraticCurveTo(-34 - flap, -6, -44 + flap, 12); ctx.lineTo(-10, -4); ctx.closePath(); ctx.fill();
  ctx.restore();

  ctx.restore();
}

function bar(x, y, w, h, v, max, color, label, warn) {
  ctx.fillStyle = 'rgba(15,23,42,0.6)'; rrect(x, y, w, h, h / 2); ctx.fill();
  ctx.fillStyle = warn ? '#f87171' : color;
  rrect(x + 1, y + 1, Math.max(0, (w - 2) * clamp(v / max, 0, 1)), h - 2, (h - 2) / 2); ctx.fill();
  if (label) txt(label, x, y - 4, 12, '#cbd5e1');
}

function drawHud() {
  var s = S.stats, r = S.ride, rg = region();
  panel(16, 14, 300, 96, 'rgba(15,23,42,0.55)');
  bar(28, 40, 150, 10, s.stamina, 100, '#4ade80', '马匹体力');
  bar(190, 40, 110, 10, s.vigor, 100, '#60a5fa', '你的精力');
  bar(28, 72, 150, 8, s.bond, 100, '#fbbf24', '羁绊 ' + Math.round(s.bond));
  txt('第 ' + s.day + ' 天 · ' + rg.name + ' · ' + weatherName(r.weather), 28, 100, 13, '#e2e8f0');

  panel(W - 236, 14, 220, 74, 'rgba(15,23,42,0.55)');
  txt('银角 ' + s.coin + '   干草 ' + s.fodder + '   清水 ' + s.water, W - 220, 38, 14, '#e2e8f0');
  txt('见闻 ' + s.insight + '   声望 ' + s.renown + '★   药膏 ' + s.medicine, W - 220, 60, 14, '#e2e8f0');
  if (s.injury > 0) txt('伤病 ×' + s.injury + '（速度下降）', W - 220, 80, 12, '#fca5a5');
  else if (s.cargo > 0) txt('货舱：海盐 ×' + s.cargo, W - 220, 80, 12, '#fde68a');

  var pw = 420, px = W / 2 - pw / 2, py = H - 44;
  ctx.fillStyle = 'rgba(15,23,42,0.6)'; rrect(px, py, pw, 14, 7); ctx.fill();
  ctx.fillStyle = '#fbbf24'; rrect(px + 1, py + 1, (pw - 2) * clamp(r.dist / r.target, 0, 1), 12, 6); ctx.fill();
  var nd = node(), nx = NODES[Math.min(S.i + 1, NODES.length - 1)];
  txt(nd.name + ' → ' + nx.name + '   ' + Math.round(r.dist / PX_PER_LI) + ' / ' + Math.round(r.target / PX_PER_LI) + ' 里', W / 2, py - 6, 13, '#e2e8f0', 'center');

  var gears = ['漫步', '小跑', '疾驰'];
  for (var i = 0; i < 3; i++) {
    var gx = W / 2 - 120 + i * 82;
    ctx.globalAlpha = r.gear === i ? 1 : 0.45;
    ctx.fillStyle = r.gear === i ? '#fbbf24' : '#1e293b';
    rrect(gx, H - 76, 74, 24, 8); ctx.fill();
    txt((i + 1) + ' ' + gears[i], gx + 37, H - 59, 13, r.gear === i ? '#1f2937' : '#cbd5e1', 'center', '600');
    ctx.globalAlpha = 1;
  }
  btn(W - 96, H - 46, 80, 32, '旅志 C', function () { openCodex(); });
}
function weatherName(w) {
  return ({ clear: '晴', rain: '雨', sandstorm: '沙暴', blizzard: '暴雪', fog: '迷雾', gale: '劲风', heat: '酷暑', tide: '涨潮', rockfall: '落石' })[w] || w;
}

function drawThreat() {
  var o = S.ride.threat.obj;
  var t = THREATS[o.type] || { name: '来敌', act: '驱赶' };
  panel(W / 2 - 300, 130, 600, 260, 'rgba(15,23,42,0.92)', '#f87171');
  txt('！ ' + t.name, W / 2, 176, 26, '#fca5a5', 'center', '700');
  txt('它挡在路中间。你怎么选？', W / 2, 206, 15, '#cbd5e1', 'center');
  btn(W / 2 - 280, 232, 176, 110, '1 ' + t.act, function () { resolveThreat(0); }, { hot: true });
  txt('1 · ' + t.act, W / 2 - 192, 266, 17, '#1f2937', 'center', '700');
  txt('体力 −8  银角 −3', W / 2 - 192, 292, 12, '#78350f', 'center');
  txt('七成把握', W / 2 - 192, 320, 12, '#78350f', 'center');
  btn(W / 2 - 88, 232, 176, 110, '2 疾驰甩脱', function () { resolveThreat(1); });
  txt('2 · 疾驰甩脱', W / 2, 266, 17, '#e2e8f0', 'center', '700');
  txt('体力 −18  精力 −5', W / 2, 292, 12, '#94a3b8', 'center');
  txt('八成把握', W / 2, 320, 12, '#94a3b8', 'center');
  btn(W / 2 + 104, 232, 176, 110, '3 正面应对', function () { resolveThreat(2); });
  txt('3 · 正面应对', W / 2 + 192, 266, 17, '#e2e8f0', 'center', '700');
  txt('精力 −18  可能受伤', W / 2 + 192, 292, 12, '#94a3b8', 'center');
  txt('声望 +1  见闻 +2', W / 2 + 192, 320, 12, '#94a3b8', 'center');
}

function drawNode() {
  var nd = node(), rg = region(), s = S.stats;
  panel(W / 2 - 400, 60, 800, 420, 'rgba(15,23,42,0.9)', 'rgba(148,163,184,0.3)');
  txt(nd.name, W / 2 - 370, 104, 28, '#fde68a', 'center');
  txt(kindName(nd.kind) + ' · ' + rg.name, W / 2 - 370, 130, 14, '#94a3b8', 'center');

  if (S.nodeUi.shop) drawShop(); else if (S.nodeUi.quests) drawQuestBoard(); else {
    txt('第 ' + s.day + ' 天 · 走了 ' + Math.round(totalProgress()) + ' 里（全程 ' + totalDistance() + ' 里）', W / 2 - 370, 166, 14, '#cbd5e1', 'center');
    if (S.nodeUi.msg) txt(S.nodeUi.msg, W / 2 - 370, 192, 13, '#fbbf24', 'center');

    btn(W / 2 - 370, 214, 240, 58, '补给交易', function () { S.nodeUi.shop = true; S.nodeUi.msg = ''; }, { hot: true });
    btn(W / 2 - 110, 214, 240, 58, '喂草安抚', function () {
      if (s.fodder <= 0) { S.nodeUi.msg = '没有干草了。'; return; }
      s.fodder -= 1; s.bond += 5; s.stamina = clamp(s.stamina + 8, 0, 100);
      S.nodeUi.msg = '青骢把头蹭进你怀里。羁绊 +5';
      clampAll(); save(); tone(523, 0.2, 'sine', 0.05);
    }, { sub: '干草 −1 · 羁绊 +5' });
    btn(W / 2 + 150, 214, 240, 58, '歇一晚', function () {
      s.day += 1;
      if (s.fodder > 0) s.fodder -= 1; else s.stamina -= 15;
      if (s.water > 0) s.water -= 1; else s.vigor -= 15;
      s.stamina = clamp(s.stamina + 30, 0, 100); s.vigor = clamp(s.vigor + 30, 0, 100);
      s.injury = Math.max(0, s.injury - 1); s.bond += 1;
      S.nodeUi.msg = '你睡了个好觉。体力精力回升，伤也好些了。';
      clampAll(); save();
    }, { sub: '1 天 · 体力精力 +30' });

    btn(W / 2 - 370, 286, 240, 58, '速写风物', function () {
      if (S.sketched[nd.id]) { S.nodeUi.msg = '这里已经画过了。'; return; }
      S.sketched[nd.id] = 1; s.insight += 4; s.vigor -= 5;
      S.nodeUi.msg = '你画下了' + nd.name + '。见闻 +4';
      S.journal.push('速写：' + nd.name + '（' + rg.name + '）');
      clampAll(); save(); tone(880, 0.15, 'sine', 0.04);
    }, { sub: '见闻 +4（每处一次）' });
    btn(W / 2 - 110, 286, 240, 58, '接个委托', function () {
      var available = QUESTS.filter(function (q) { return q.node === nd.id && !S.seen['q:' + q.id]; });
      if (!available.length) { S.nodeUi.msg = '这里没有未完成的委托。'; return; }
      S.nodeUi.quests = true;
    }, { sub: '查看本地委托与选择' });
    btn(W / 2 + 150, 286, 240, 58, '诊治马匹', function () {
      if (s.medicine > 0 && s.injury > 0) {
        s.medicine -= 1; s.injury -= 1; s.bond += 3;
        S.nodeUi.msg = '你给马上了药。伤病 −1';
        tone(523, 0.2, 'sine', 0.05);
      } else if (s.injury <= 0) S.nodeUi.msg = '马好好的，不用治。';
      else S.nodeUi.msg = '没有药膏了，去补给点买。';
      clampAll(); save();
    }, { sub: '药膏 −1 · 伤病 −1' });

    var jy = wrap(quoteFor(nd), W / 2 - 370, 388, 740, 22, 14, '#94a3b8', '');
    btn(W / 2 - 140, 430, 280, 46, '继续赶路 →', function () { S.scene = 'map'; }, { hot: true });
  }
  btn(W / 2 + 300, 430, 84, 46, '旅志', function () { openCodex(); });
}
function drawQuestBoard() {
  var available = QUESTS.filter(function (q) { return q.node === node().id && !S.seen['q:' + q.id]; });
  txt('本地委托', W / 2, 148, 24, '#fde68a', 'center', '700');
  for (var i = 0; i < available.length; i++) {
    var q = available[i], allowed = !q.requires || evalCond(q.requires, condVars());
    btn(W / 2 - 320, 178 + i * 70, 640, 58, q.title, (function (quest) {
      return function () {
        if (quest.requires && !evalCond(quest.requires, condVars())) return;
        S.nodeUi.quests = false;
        S.event = { def: quest, result: null, kind: 'quest', returnScene: 'node' }; S.scene = 'event';
      };
    })(q), { disabled: !allowed, sub: q.giver + (allowed ? '' : ' · 需要 ' + q.requires) });
  }
  if (!available.length) txt('这里的委托都已完成。', W / 2, 216, 16, '#94a3b8', 'center');
  btn(W / 2 + 150, 430, 230, 46, '← 回到' + node().name, function () { S.nodeUi.quests = false; });
}
function kindName(k) { return ({ village: '村落', stable: '驿站', camp: '营地', ruin: '废墟', gate: '关隘' })[k] || k; }
function quoteFor(nd) {
  var lines = [
    '风从很远的地方来，带着别处的气味。',
    '有人在这里生过火，灰还是温的。',
    '你翻开游记，缺页的地方像一道没长好的疤。',
    '马在旁边嚼草，嚼得很慢，像在想事情。',
    '天色将晚，远处的路还很长。'
  ];
  var i = 0; for (var k = 0; k < nd.id.length; k++) i += nd.id.charCodeAt(k);
  return lines[i % lines.length];
}
function totalProgress() {
  var t = 0; for (var i = 0; i < S.i; i++) t += NODES[i].distance;
  if (S.ride) t += Math.min(S.ride.dist, S.ride.target) / PX_PER_LI;
  return t;
}

function drawShop() {
  var s = S.stats;
  txt('补给交易', W / 2, 104, 24, '#fde68a', 'center', '700');
  txt('银角：' + s.coin + '   干草：' + s.fodder + '   清水：' + s.water + '   药膏：' + s.medicine + '   货舱：' + s.cargo, W / 2, 132, 14, '#cbd5e1', 'center');
  var items = shopItems();
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var x = W / 2 - 380 + (i % 3) * 250, y = 160 + Math.floor(i / 3) * 74;
    btn(x, y, 240, 60, it.name, (function (item) {
      return function () {
        if (S.stats.coin < item.cost) { S.nodeUi.msg = '银角不够。'; return; }
        S.stats.coin -= item.cost; item.run(); clampAll();
        S.nodeUi.msg = '买下了「' + item.name + '」。';
        tone(659, 0.15, 'sine', 0.05); save();
      };
    })(it), { disabled: s.coin < it.cost });
    txt(it.name, x + 120, y + 26, 17, s.coin < it.cost ? '#94a3b8' : '#e2e8f0', 'center', '600');
    txt(it.cost + ' 银角', x + 120, y + 48, 13, s.coin < it.cost ? '#64748b' : '#fbbf24', 'center');
  }
  btn(W / 2 - 380, 320, 240, 56, s.cargo > 0 ? '卖掉海盐 ×' + s.cargo : '（没有货可卖）', function () { sellSalt(); S.nodeUi.msg = ''; }, { hot: s.cargo > 0, disabled: s.cargo <= 0 });
  txt(s.cargo > 0 ? '雪原价高，别处价低' : '在盐田村买盐，到雪原去卖', W / 2 - 260, 388, 12, '#94a3b8', 'center');
  btn(W / 2 + 150, 430, 230, 46, '← 回到' + node().name, function () { S.nodeUi.shop = false; });
}

function drawEvent() {
  var e = S.event; if (!e) return;
  var d = e.def;
  panel(W / 2 - 360, 90, 720, 380, 'rgba(15,23,42,0.93)', 'rgba(251,191,36,0.45)');
  txt(d.title, W / 2, 136, 26, '#fde68a', 'center', '700');
  var y = wrap(d.text, W / 2 - 320, 180, 640, 26, 16, '#e2e8f0', '');

  if (!e.result) {
    for (var i = 0; i < d.choices.length; i++) {
      var c = d.choices[i];
      var okReq = !c.requires || evalCond(c.requires, condVars());
      var bw = 640 / Math.min(3, d.choices.length) - 12;
      var bx = W / 2 - 320 + i * (bw + 12);
      btn(bx, y + 34, bw, 150, c.label, (function (idx) { return function () { chooseEvent(idx); }; })(i),
        { disabled: !okReq, hot: i === 0 });
      var cx = bx + bw / 2;
      txt((i + 1) + ' · ' + c.label, cx, y + 74, 16, okReq ? (i === 0 ? '#1f2937' : '#e2e8f0') : '#94a3b8', 'center', '600');
      var eff = [];
      for (var k in c.effects) if (Object.prototype.hasOwnProperty.call(c.effects, k)) eff.push(labelOf(k) + (c.effects[k] > 0 ? ' +' : ' ') + c.effects[k]);
      if (eff.length) wrap(eff.join('  '), cx, y + 104, bw - 24, 18, 12, okReq ? (i === 0 ? '#78350f' : '#94a3b8') : '#64748b', 'center');
      if (!okReq) txt('（需要：' + c.requires + '）', cx, y + 168, 11, '#64748b', 'center');
    }
  } else {
    wrap(e.result.log, W / 2 - 320, y + 40, 640, 26, 17, '#fde68a', '');
    if (e.result.delta) txt(e.result.delta, W / 2, y + 100, 14, '#94a3b8', 'center');
    btn(W / 2 - 90, y + 150, 180, 48, '继续 →', function () { nextLeg(); }, { hot: true });
  }
}

function openCodex() { S.codexReturn = S.scene; S.scene = 'codex'; }
function leaveCodex() { S.scene = S.codexReturn || (S.ending ? 'ending' : 'map'); }
function drawCodex() {
  panel(W / 2 - 400, 50, 800, 440, 'rgba(15,23,42,0.94)', 'rgba(148,163,184,0.35)');
  var s = S.stats;
  txt('旅志 · 风物图鉴', W / 2, 92, 26, '#fde68a', 'center', '700');
  txt('见闻 ' + s.insight + '   羁绊 ' + Math.round(s.bond) + '   声望 ' + s.renown + '★   日程 第 ' + s.day + ' 天   里程 ' + Math.round(totalProgress()) + '/' + totalDistance() + ' 里', W / 2, 120, 14, '#cbd5e1', 'center');

  var x = W / 2 - 370, y = 152;
  txt('走过的地方', x, y, 15, '#fbbf24', '600');
  for (var i = 0; i < REGIONS.length; i++) {
    var rg = REGIONS[i];
    var cx = x + (i % 4) * 190, cy = y + 18 + Math.floor(i / 4) * 30;
    ctx.fillStyle = S.seen[rg.id] ? rg.palette[2] : '#334155';
    rrect(cx, cy, 16, 16, 4); ctx.fill();
    txt(rg.name + (S.seen[rg.id] ? '' : '（未至）'), cx + 24, cy + 13, 14, S.seen[rg.id] ? '#e2e8f0' : '#64748b');
  }

  var hidden = SECRETS.filter(function (e) { return !S.seen['sc:' + e.id]; });
  if (hidden.length && hidden[0].hint) txt('传闻：' + hidden[0].hint, x, y + 82, 12, '#94a3b8');
  txt('游记', x, y + 96, 15, '#fbbf24', '600');
  var jy = y + 120;
  if (!S.journal.length) txt('—— 还什么都没记下。', x, jy, 14, '#64748b');
  var show = S.journal.slice(-8);
  for (var j = 0; j < show.length; j++) {
    jy = wrap('· ' + show[j], x, jy, 740, 22, 14, '#cbd5e1', '');
  }
  if (S.ending) txt('结局：' + S.ending.name, x, jy + 12, 15, '#fde68a', '600');
  btn(W / 2 - 80, H - 92, 160, 44, '返回 (Esc)', function () { leaveCodex(); }, { hot: true });
}

function drawEnding() {
  var g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#111827'); g.addColorStop(1, '#3f2d16');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  var e = S.ending;
  txt('结局 · ' + (e ? e.name : '归乡'), W / 2, 110, 40, '#fde68a', 'center', '700');
  var y = wrap(e ? e.text : '', W / 2 - 330, 170, 660, 30, 18, '#e2e8f0', '');
  var s = S.stats;
  txt('见闻 ' + s.insight + '   羁绊 ' + Math.round(s.bond) + '   声望 ' + s.renown + '★   银角 ' + s.coin + '   历时 ' + s.day + ' 天', W / 2, y + 30, 15, '#cbd5e1', 'center');
  var uniq = 0; for (var k in S.seen) if (S.seen[k]) uniq++;
  txt('走过 ' + Math.min(uniq, REGIONS.length) + '/' + REGIONS.length + ' 处风貌，记下 ' + S.journal.length + ' 条游记', W / 2, y + 56, 14, '#94a3b8', 'center');
  btn(W / 2 - 190, y + 96, 180, 50, '再走一圈', function () { newGame(); S.scene = 'map'; introEvent(); }, { hot: true });
  btn(W / 2 + 10, y + 96, 180, 50, '看看旅志', function () { openCodex(); });
}

function drawMobile() {
  var bw = 92, bh = 92, by = H - 150;
  btn(W - 300, by, bw, bh, '档位 −', function () { setGear(S.ride.gear - 1); }, {});
  btn(W - 196, by, bw, bh, '跃障', function () { jump(); }, { hot: true });
  btn(W - 92, by, bw, bh, '档位 +', function () { setGear(S.ride.gear + 1); }, {});
}

/* ---------------------------------------------------------------- 启动 */

newGame();
resize();
requestAnimationFrame(loop);

/* 调试 / 自动化测试钩子：只读状态 + 按标签点按钮，便于无头冒烟测试。 */
window.__JOURNEY__ = {
  state: function () { return S; },
  buttons: function () { return UI.map(function (b) { return { label: b.label, x: b.x, y: b.y, w: b.w, h: b.h }; }); },
  click: function (label) {
    for (var i = 0; i < UI.length; i++) if (UI[i].label === label && !UI[i].disabled) { UI[i].fn(); return true; }
    return false;
  },
  key: function (code) { onKey(code); },
  step: function (dt) { update(dt); render(); }
};
})();
`;

/** HTML 外壳：只负责画布与自适应，不含任何游戏内容。 */
export function journeyShell(title: string, dataJson: string, engineJs: string): string {
  return (
    '<!doctype html>\n' +
    '<html lang="zh-CN">\n' +
    '<head>\n' +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />\n' +
    '<meta name="theme-color" content="#0b1a2b" />\n' +
    '<title>' +
    title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
    '</title>\n' +
    '<style>\n' +
    '  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }\n' +
    '  html, body { margin: 0; height: 100%; background: #070d16; overflow: hidden;\n' +
    '    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif; }\n' +
    '  #wrap { position: fixed; inset: 0; display: grid; place-items: center; padding: 8px; }\n' +
    '  #game { width: 100%; height: 100%; max-width: 1280px; max-height: 720px;\n' +
    '    aspect-ratio: 16 / 9; object-fit: contain; touch-action: none;\n' +
    '    border-radius: 14px; box-shadow: 0 24px 80px rgba(0,0,0,.45); background: #0b1a2b; }\n' +
    '  @media (max-aspect-ratio: 16/9) { #game { width: 100%; height: auto; } }\n' +
    '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<div id="wrap"><canvas id="game" width="960" height="540"></canvas></div>\n' +
    '<script>window.__JOURNEY_DATA__ = ' +
    dataJson.replace(/</g, '\\u003c') +
    ';</script>\n' +
    '<script>\n' +
    engineJs +
    '\n</script>\n' +
    '</body>\n' +
    '</html>\n'
  );
}
