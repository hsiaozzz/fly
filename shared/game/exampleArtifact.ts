import type { GameArtifact } from "./types";

// Hand-authored offline fixture for editing and play; never model output.
const example: GameArtifact = {
  title: "苹果小果园 · 预置示例",
  description: "ARCANE 手工预置的离线接苹果示例，用于体验编辑、试玩与下载，不代表真实 AI 生成质量。左右移动篮子，接到 10 个苹果获胜，漏掉 3 个失败。",
  controls: ["点击开始游戏", "方向键 ← → 或 A / D 移动篮子", "手机按住左右按钮，也可在画布上拖动篮子", "接到 10 个获胜，漏掉 3 个失败", "重新开始会清空得分和漏接数"],
  files: [
    {
      path: "index.html", language: "html", content: `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>苹果小果园 · 预置示例</title><link rel="stylesheet" href="style.css"><script src="game.js" defer></script></head>
<body><main class="game-shell"><header><span class="eyebrow">离线预置示例</span><h1>苹果小果园</h1><p>接到 10 个苹果获胜，漏掉 3 个失败。</p></header>
<div class="scoreboard"><span>已接 <strong id="caught">0</strong> / 10</span><span>漏接 <strong id="missed">0</strong> / 3</span></div>
<canvas id="game-canvas" width="560" height="460" aria-label="接苹果游戏画面：左右移动篮子接住红色苹果。">你的浏览器需要支持 Canvas 才能运行这个离线示例。</canvas>
<p id="game-status" class="game-status" role="status" aria-live="polite" data-state="ready">准备好了，点击开始游戏。</p>
<div class="actions"><button id="start" type="button">开始游戏</button><button id="restart" class="secondary" type="button">重新开始</button></div>
<div class="touch-controls" aria-label="篮子方向控制"><button id="move-left" type="button" aria-label="左移">← 左移</button><span>按住移动<br>← → / A D</span><button id="move-right" type="button" aria-label="右移">右移 →</button></div>
<footer>这是手工预置示例，可离线试玩、修改源码和下载。</footer></main></body></html>`,
    },
    {
      path: "style.css", language: "css", content: `*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#102b29;color:#edf7eb;font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif}body{padding:18px 12px}.game-shell{width:min(100%,560px);margin:auto}header{margin-bottom:14px}.eyebrow{color:#8fe3c6;font-size:12px;letter-spacing:2px}h1{font-size:clamp(24px,5vw,34px);margin:6px 0}header p{margin:0;color:#c3d9cd;font-size:14px}.scoreboard{display:flex;justify-content:space-between;padding:12px 16px;background:#1b423c;border:1px solid #315c50;border-bottom:0;border-radius:16px 16px 0 0}.scoreboard strong{font-size:22px;color:#ffdb80}canvas{display:block;width:100%;height:auto;aspect-ratio:560/460;border:1px solid #315c50;border-radius:0 0 16px 16px;touch-action:none;background:#153e39}.game-status{min-height:24px;margin:12px 0;text-align:center;font-weight:600;font-size:15px}.actions{display:flex;gap:10px}button{flex:1;min-height:46px;border:0;border-radius:12px;background:#ffdb80;color:#193a30;font:700 16px system-ui;cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none}button:disabled{opacity:.48;cursor:default}button:focus-visible{outline:3px solid white;outline-offset:3px}.secondary{background:#254d43;color:#e8f3e8;border:1px solid #467161}.touch-controls{display:flex;align-items:center;gap:12px;margin-top:12px}.touch-controls button{background:#58d7be;min-height:58px}.touch-controls span{text-align:center;color:#b4d2c1;font-size:12px;line-height:1.5;min-width:72px}footer{text-align:center;color:#9ebdae;font-size:12px;margin:16px 0 0}@media(max-width:420px){body{padding:12px 10px}header{margin-bottom:10px}.scoreboard{padding:8px 12px}.game-status{font-size:13px}.touch-controls{gap:8px}}
/* Embedded and landscape views keep the full playfield and controls together. */
@media(max-height:850px) and (min-width:601px){body{padding:8px}.game-shell{width:min(100%,900px);height:calc(100vh - 16px);display:grid;grid-template-columns:minmax(0,1.35fr) minmax(220px,.85fr);grid-template-rows:auto auto minmax(28px,1fr) auto auto auto;gap:8px 16px}header,.scoreboard,.game-status,.actions,.touch-controls,footer{grid-column:2;margin:0}header{grid-row:1}.eyebrow{font-size:10px;letter-spacing:1px}h1{font-size:22px;margin:2px 0}header p{font-size:12px;line-height:1.4}.scoreboard{grid-row:2;padding:6px 10px;border:1px solid #315c50;border-radius:10px;font-size:12px}.scoreboard strong{font-size:18px}canvas{grid-column:1;grid-row:1/-1;justify-self:center;align-self:center;width:min(100%,calc((100vh - 16px)*1.2173913));height:auto;border-radius:12px}.game-status{grid-row:3;align-self:center;min-height:0;font-size:13px;line-height:1.4}.actions{grid-row:4;gap:8px}button{min-height:36px;font-size:13px;border-radius:9px}.touch-controls{grid-row:5;gap:8px}.touch-controls button{min-height:44px}.touch-controls span{font-size:10px;min-width:54px}footer{grid-row:6;font-size:10px;line-height:1.3}}
@media(max-height:520px) and (max-width:600px){body{padding:6px}.game-shell{width:min(100%,420px);display:grid;grid-template-columns:minmax(0,1fr);gap:4px}header{margin:0;text-align:center}.eyebrow{font-size:9px;letter-spacing:1px}h1{font-size:18px;line-height:1.2;margin:1px 0}header p{font-size:10px;line-height:1.3}.scoreboard{padding:4px 10px;border:1px solid #315c50;border-radius:8px;font-size:11px;line-height:1.2}.scoreboard strong{font-size:16px}canvas{justify-self:center;width:min(100%,calc((100vh - 220px)*1.2173913));height:auto;border-radius:8px}.game-status{min-height:18px;margin:0;font-size:11px;line-height:1.3}.actions{gap:6px}button{min-height:32px;font-size:12px;border-radius:8px}.touch-controls{gap:8px;margin:0}.touch-controls button{min-height:34px}.touch-controls span{font-size:9px;min-width:54px;line-height:1.2}footer{font-size:9px;line-height:1.3;margin:0}}`,
    },
    {
      path: "game.js", language: "javascript", content: `// Hand-authored offline example: no model calls, downloads or network access.
(function () {
  'use strict';
  const canvas = document.querySelector('#game-canvas');
  const ctx = canvas.getContext('2d');
  const caughtLabel = document.querySelector('#caught');
  const missedLabel = document.querySelector('#missed');
  const statusLabel = document.querySelector('#game-status');
  const startButton = document.querySelector('#start');
  const restartButton = document.querySelector('#restart');
  const width = canvas.width, height = canvas.height;
  const basket = { x: width / 2, y: height - 48, width: 112, height: 26 };
  const keys = new Set(), touches = new Map();
  let apples = [], caught = 0, missed = 0, state = 'ready';
  let spawnAfter = 0.4, lastFrame = null, frameId = null;
  let dragging = null;

  function updateLabels(message) {
    caughtLabel.textContent = String(caught);
    missedLabel.textContent = String(missed);
    statusLabel.textContent = message;
    statusLabel.dataset.state = state;
    startButton.disabled = state === 'playing';
  }
  function clearInput() { keys.clear(); touches.clear(); dragging = null; }
  function clampBasket() {
    basket.x = Math.max(basket.width / 2 + 8, Math.min(width - basket.width / 2 - 8, basket.x));
  }
  function applePicture(apple) {
    ctx.fillStyle = '#f45a5a';
    ctx.beginPath(); ctx.arc(apple.x - 5, apple.y, 12, 0, Math.PI * 2); ctx.arc(apple.x + 5, apple.y, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffb7a2'; ctx.beginPath(); ctx.arc(apple.x - 8, apple.y - 4, 3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#7f5030'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(apple.x, apple.y - 10); ctx.lineTo(apple.x + 2, apple.y - 18); ctx.stroke();
    ctx.fillStyle = '#a7df84'; ctx.beginPath(); ctx.ellipse(apple.x + 7, apple.y - 15, 6, 3, -0.5, 0, Math.PI * 2); ctx.fill();
  }
  function draw() {
    const sky = ctx.createLinearGradient(0, 0, 0, height); sky.addColorStop(0, '#163e39'); sky.addColorStop(1, '#286454');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#345d49';
    for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.arc(i * 120 - 18, 10, 74, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#214b38'; ctx.fillRect(0, height - 22, width, 22);
    ctx.strokeStyle = '#477459'; ctx.lineWidth = 2;
    for (let x = 8; x < width; x += 20) { ctx.beginPath(); ctx.moveTo(x, height - 2); ctx.lineTo(x + 4, height - 16); ctx.stroke(); }
    apples.forEach(applePicture);
    const left = basket.x - basket.width / 2;
    ctx.fillStyle = '#58d7be';
    ctx.beginPath(); ctx.moveTo(left, basket.y); ctx.lineTo(left + basket.width, basket.y); ctx.lineTo(left + basket.width - 10, basket.y + basket.height); ctx.lineTo(left + 10, basket.y + basket.height); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#217e6c'; ctx.lineWidth = 2;
    for (let x = left + 18; x < left + basket.width - 8; x += 18) { ctx.beginPath(); ctx.moveTo(x, basket.y + 3); ctx.lineTo(x, basket.y + basket.height - 3); ctx.stroke(); }
    ctx.fillStyle = '#b5fff1'; ctx.fillRect(left - 2, basket.y - 4, basket.width + 4, 6);
    if (state !== 'playing') {
      ctx.fillStyle = 'rgba(9,31,27,.7)'; ctx.fillRect(36, height / 2 - 56, width - 72, 112);
      ctx.textAlign = 'center'; ctx.fillStyle = '#ffdb80'; ctx.font = 'bold 30px system-ui';
      ctx.fillText(state === 'won' ? '收获成功！' : state === 'lost' ? '再试一次吧' : '今天的目标：10 个苹果', width / 2, height / 2 - 10);
      ctx.fillStyle = '#edf7eb'; ctx.font = '17px system-ui';
      ctx.fillText(state === 'ready' ? '点击开始，然后左右移动篮子' : '点击重新开始，开启新的一局', width / 2, height / 2 + 27);
    }
  }
  function finish(nextState) {
    state = nextState; clearInput();
    updateLabels(nextState === 'won' ? '胜利！你接到了 10 个苹果。' : '失败：漏掉了 3 个苹果，重新开始再试一次。');
  }
  function begin() {
    if (frameId !== null) cancelAnimationFrame(frameId);
    apples = []; caught = 0; missed = 0; spawnAfter = 0.4;
    basket.x = width / 2; state = 'playing'; lastFrame = null; clearInput();
    updateLabels('加油！左右移动篮子接苹果。'); draw();
    frameId = requestAnimationFrame(tick);
  }
  function tick(timestamp) {
    frameId = null;
    if (state !== 'playing') return;
    const dt = lastFrame === null ? 0 : Math.min((timestamp - lastFrame) / 1000, 0.04);
    lastFrame = timestamp;
    const left = keys.has('ArrowLeft') || keys.has('a') || [...touches.values()].includes(-1);
    const right = keys.has('ArrowRight') || keys.has('d') || [...touches.values()].includes(1);
    basket.x += ((right ? 1 : 0) - (left ? 1 : 0)) * 470 * dt; clampBasket();
    spawnAfter -= dt;
    if (spawnAfter <= 0) {
      apples.push({ x: 30 + Math.random() * (width - 60), y: -20, speed: 165 + Math.random() * 20 + caught * 3 });
      spawnAfter += 1.15;
    }
    const remaining = [];
    for (const apple of apples) {
      const previousY = apple.y;
      apple.y += apple.speed * dt;
      const reachesBasket = previousY + 12 < basket.y + basket.height && apple.y + 12 >= basket.y && apple.y - 12 <= basket.y + basket.height;
      if (reachesBasket && Math.abs(apple.x - basket.x) <= basket.width / 2 + 8) {
        caught++; updateLabels('接住了！继续收集 10 个苹果。');
        if (caught >= 10) { finish('won'); break; }
      } else if (apple.y - 12 > height) {
        missed++; updateLabels('漏接了一个，还能继续！');
        if (missed >= 3) { finish('lost'); break; }
      } else remaining.push(apple);
    }
    apples = remaining; draw();
    if (state === 'playing') frameId = requestAnimationFrame(tick);
  }
  startButton.addEventListener('click', begin);
  restartButton.addEventListener('click', begin);
  document.addEventListener('keydown', event => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (!['ArrowLeft', 'ArrowRight', 'a', 'd'].includes(key)) return;
    event.preventDefault(); if (state === 'playing') keys.add(key);
  });
  document.addEventListener('keyup', event => keys.delete(event.key.length === 1 ? event.key.toLowerCase() : event.key));
  for (const [id, direction] of [['#move-left', -1], ['#move-right', 1]]) {
    const button = document.querySelector(id);
    button.addEventListener('pointerdown', event => {
      event.preventDefault(); if (state !== 'playing') return;
      button.setPointerCapture(event.pointerId); touches.set(event.pointerId, direction);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, event => touches.delete(event.pointerId));
  }
  function drag(event) {
    const rect = canvas.getBoundingClientRect();
    basket.x = (event.clientX - rect.left) * width / rect.width; clampBasket(); draw();
  }
  canvas.addEventListener('pointerdown', event => {
    if (state !== 'playing') return;
    event.preventDefault(); dragging = event.pointerId; canvas.setPointerCapture(event.pointerId); drag(event);
  });
  canvas.addEventListener('pointermove', event => { if (dragging === event.pointerId && state === 'playing') drag(event); });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, event => { if (dragging === event.pointerId) dragging = null; });
  window.addEventListener('blur', clearInput);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearInput(); lastFrame = null; } });
  draw();
})();`,
    },
  ],
};

/** Fresh arrays and file records let each workspace edit its own example. */
export function createExampleArtifact(): GameArtifact {
  return structuredClone(example);
}
