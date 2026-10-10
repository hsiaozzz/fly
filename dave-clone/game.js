/**
 * Dave Clone - 潜水员戴夫小游戏复刻
 * 纯原生 Canvas + 单文件实现，支持白天潜水 / 夜晚寿司店经营 / 装备升级循环。
 */

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');

// UI refs
const ui = document.getElementById('ui');
const oxygenFill = document.getElementById('oxygen-fill');
const oxygenText = document.getElementById('oxygen-text');
const weightFill = document.getElementById('weight-fill');
const weightText = document.getElementById('weight-text');
const goldText = document.getElementById('gold-text');
const depthText = document.getElementById('depth-text');
const messageEl = document.getElementById('message');
const crosshair = document.getElementById('crosshair');

const startScreen = document.getElementById('start-screen');
const startBtn = document.getElementById('start-btn');
const shopPanel = document.getElementById('shop-panel');
const menuList = document.getElementById('menu-list');
const openShopBtn = document.getElementById('open-shop-btn');
const upgradeBtn = document.getElementById('upgrade-btn');
const sleepBtn = document.getElementById('sleep-btn');
const upgradesPanel = document.getElementById('upgrades');
const closeUpgrades = document.getElementById('close-upgrades');
const daySummary = document.getElementById('day-summary');
const summaryTitle = document.getElementById('summary-title');
const summaryBody = document.getElementById('summary-body');
const nextDayBtn = document.getElementById('next-day-btn');

let width, height;
function resize() {
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = width * window.devicePixelRatio;
  canvas.height = height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}
window.addEventListener('resize', resize);
resize();

// Game state
const STATE = {
  mode: 'start', // start, dive, shop, restaurant, upgrades, summary
  day: 1,
  gold: 0,
  maxOxygen: 100,
  oxygen: 100,
  maxWeight: 10,
  weight: 0,
  harpoonSpeed: 1,
  harpoonRange: 1,
  netRange: 0,
  swimSpeed: 1,
  upgradesOwned: { tank: false, suit: false, net: false, weight: false },
  inventory: [], // { id, name, value, weight }
  caughtToday: {},
  soldToday: 0,
  customersServed: 0,
};

const FISH_TYPES = [
  { id: 'sardine', name: '沙丁鱼', color: '#a0c4ff', depth: [0, 80], value: 12, weight: 1, speed: 1.2, size: 16, chance: 0.35 },
  { id: 'mackerel', name: '鲭鱼', color: '#9ae6b4', depth: [20, 120], value: 22, weight: 1, speed: 1.5, size: 20, chance: 0.25 },
  { id: 'tuna', name: '金枪鱼', color: '#63b3ed', depth: [60, 200], value: 55, weight: 2, speed: 2.2, size: 26, chance: 0.15 },
  { id: 'snapper', name: '红鲷鱼', color: '#fc8181', depth: [100, 320], value: 80, weight: 2, speed: 1.8, size: 22, chance: 0.12 },
  { id: 'angler', name: '鮟鱇鱼', color: '#d6bcfa', depth: [200, 600], value: 140, weight: 3, speed: 1.0, size: 28, chance: 0.08 },
  { id: 'coelacanth', name: '腔棘鱼', color: '#f6e05e', depth: [400, 900], value: 320, weight: 4, speed: 1.3, size: 32, chance: 0.03 },
];

// Entities
const player = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, onSurface: true };
let fishes = [];
let harpoons = [];
let bubbles = [];
let particles = [];

const keys = {};
let mouse = { x: 0, y: 0 };
let camera = { y: 0 };
let seaBottom = 2000;
let timeInGame = 0;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rand(a, b) { return Math.random() * (b - a) + a; }
function showMessage(text) {
  messageEl.textContent = text;
  messageEl.classList.add('show');
  setTimeout(() => messageEl.classList.remove('show'), 1800);
}

// Input
window.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
window.addEventListener('mousemove', e => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  crosshair.style.left = e.clientX + 'px';
  crosshair.style.top = e.clientY + 'px';
});
window.addEventListener('mousedown', () => {
  if (STATE.mode === 'dive') fireHarpoon();
});

startBtn.addEventListener('click', startDive);
openShopBtn.addEventListener('click', openRestaurant);
upgradeBtn.addEventListener('click', openUpgrades);
sleepBtn.addEventListener('click', endDay);
closeUpgrades.addEventListener('click', closeUpgradesPanel);
nextDayBtn.addEventListener('click', nextDay);

// Game loop init
function initGame() {
  player.x = width / 2;
  player.y = 60;
  player.vx = 0;
  player.vy = 0;
  STATE.oxygen = STATE.maxOxygen;
  STATE.weight = 0;
  STATE.inventory = [];
  STATE.caughtToday = {};
  STATE.soldToday = 0;
  STATE.customersServed = 0;
  fishes = [];
  harpoons = [];
  bubbles = [];
  particles = [];
  spawnFish(25);
  timeInGame = 0;
  updateUI();
}

function spawnFish(count) {
  for (let i = 0; i < count; i++) {
    const depthY = rand(80, seaBottom - 80);
    const type = pickFishByDepth(depthY);
    fishes.push(createFish(depthY, type));
  }
}

function createFish(depthY, type) {
  const dir = Math.random() > 0.5 ? 1 : -1;
  return {
    x: rand(40, width - 40),
    y: depthY,
    vx: dir * rand(0.3, 0.7) * type.speed,
    vy: rand(-0.1, 0.1),
    type,
    hp: 1,
    caught: false,
    wiggle: Math.random() * Math.PI * 2,
  };
}

function pickFishByDepth(y) {
  const candidates = FISH_TYPES.filter(t => y >= t.depth[0] && y <= t.depth[1]);
  if (!candidates.length) return FISH_TYPES[0];
  const total = candidates.reduce((s, t) => s + t.chance, 0);
  let r = Math.random() * total;
  for (const t of candidates) {
    r -= t.chance;
    if (r <= 0) return t;
  }
  return candidates[candidates.length - 1];
}

function startDive() {
  startScreen.classList.add('hidden');
  shopPanel.classList.add('hidden');
  daySummary.classList.add('hidden');
  ui.classList.remove('hidden');
  STATE.mode = 'dive';
  initGame();
  loop();
}

function endDive(reason) {
  STATE.mode = 'shop';
  convertInventoryToMenu();
  renderMenu();
  shopPanel.classList.remove('hidden');
  if (reason) showMessage(reason);
}

function convertInventoryToMenu() {
  menuList.innerHTML = '';
  const menu = {};
  let totalValue = 0;
  for (const item of STATE.inventory) {
    if (!menu[item.name]) menu[item.name] = { name: item.name, count: 0, value: 0 };
    menu[item.name].count++;
    menu[item.name].value += item.value;
    totalValue += item.value;
  }
  STATE.caughtToday = menu;
  STATE.soldToday = totalValue;
  for (const key in menu) {
    const item = menu[key];
    const div = document.createElement('div');
    div.className = 'menu-item';
    div.innerHTML = `<b>${item.name}</b><span>×${item.count} · 价值 ${item.value} G</span>`;
    menuList.appendChild(div);
  }
}

function renderMenu() {
  const total = STATE.soldToday || 0;
  document.getElementById('shop-summary').textContent = `今日收获：${Object.keys(STATE.caughtToday).length} 种鱼，总价值 ${total} G`;
}

function openRestaurant() {
  shopPanel.classList.add('hidden');
  STATE.mode = 'restaurant';
  document.getElementById('restaurant-panel').classList.remove('hidden');
  runRestaurantShift();
}

function runRestaurantShift() {
  const dining = document.getElementById('dining-area');
  dining.innerHTML = '';
  const baseCustomers = 3 + Math.floor(STATE.day / 2);
  let served = 0;
  let potential = 0;
  for (let i = 0; i < baseCustomers; i++) {
    const wants = getRandomFishForMenu();
    const cust = document.createElement('div');
    cust.className = 'customer';
    cust.textContent = '';
    cust.title = `想吃 ${wants.name}`;
    dining.appendChild(cust);
    potential += wants.value;
    setTimeout(() => {
      if (STATE.caughtToday[wants.name] && STATE.caughtToday[wants.name].count > 0) {
        cust.classList.add('eating');
        cust.textContent = '😍';
        STATE.caughtToday[wants.name].count--;
        STATE.caughtToday[wants.name].value -= wants.value;
        if (STATE.caughtToday[wants.name].count <= 0) delete STATE.caughtToday[wants.name];
        served++;
        STATE.gold += wants.value;
      } else {
        cust.classList.add('angry');
        cust.textContent = '';
      }
      updateUI();
    }, 800 + i * 700);
  }
  STATE.customersServed = served;
  STATE.soldToday = potential;
  setTimeout(() => {
    document.getElementById('restaurant-panel').classList.add('hidden');
    shopPanel.classList.remove('hidden');
    showMessage(`今晚接待了 ${baseCustomers} 位客人，满意 ${served} 人`);
  }, 3000 + baseCustomers * 700);
}

function getRandomFishForMenu() {
  return FISH_TYPES[Math.floor(Math.random() * FISH_TYPES.length)];
}

function openUpgrades() {
  shopPanel.classList.add('hidden');
  upgradesPanel.classList.remove('hidden');
}

function closeUpgradesPanel() {
  upgradesPanel.classList.add('hidden');
  shopPanel.classList.remove('hidden');
}

document.querySelectorAll('.upgrade-card').forEach(card => {
  card.querySelector('button').addEventListener('click', () => buyUpgrade(card));
});

function buyUpgrade(card) {
  const type = card.dataset.type;
  if (STATE.upgradesOwned[type]) return;
  const prices = { tank: 100, suit: 150, net: 200, weight: 250 };
  const price = prices[type];
  if (STATE.gold < price) { showMessage('金币不足'); return; }
  STATE.gold -= price;
  STATE.upgradesOwned[type] = true;
  card.classList.add('purchased');
  card.querySelector('button').textContent = '已拥有';
  if (type === 'tank') { STATE.maxOxygen = 120; }
  if (type === 'suit') { STATE.swimSpeed += 0.25; }
  if (type === 'net') { STATE.netRange += 25; }
  if (type === 'weight') { STATE.maxWeight += 3; }
  updateUI();
  showMessage('升级成功');
}

function endDay() {
  shopPanel.classList.add('hidden');
  daySummary.classList.remove('hidden');
  summaryTitle.textContent = `第 ${STATE.day} 天结束`;
  summaryBody.innerHTML = `今日收获 ${Object.values(STATE.caughtToday).reduce((s, i) => s + (i.count || 0), 0)} 条鱼，<br>寿司店接待 ${STATE.customersServed} 位客人，<br>当前金币 ${STATE.gold} G。`;
  STATE.mode = 'summary';
}

function nextDay() {
  STATE.day++;
  daySummary.classList.add('hidden');
  startDive();
}

// Harpoon
function fireHarpoon() {
  const angle = Math.atan2(mouse.y - (player.y - camera.y), mouse.x - player.x);
  harpoons.push({
    x: player.x,
    y: player.y,
    vx: Math.cos(angle) * 10,
    vy: Math.sin(angle) * 10,
    life: 40,
  });
}

// Main loop
function loop() {
  if (STATE.mode !== 'dive') return;
  update();
  render();
  requestAnimationFrame(loop);
}

function update() {
  timeInGame += 0.016;
  const accel = 0.25 * STATE.swimSpeed;
  const maxSpeed = 5 * STATE.swimSpeed;

  if (keys['w'] || keys['arrowup']) player.vy -= accel;
  if (keys['s'] || keys['arrowdown']) player.vy += accel;
  if (keys['a'] || keys['arrowleft']) player.vx -= accel;
  if (keys['d'] || keys['arrowright']) player.vx += accel;

  player.vx *= 0.95;
  player.vy *= 0.95;
  player.vx = clamp(player.vx, -maxSpeed, maxSpeed);
  player.vy = clamp(player.vy, -maxSpeed, maxSpeed);

  player.x += player.vx;
  player.y += player.vy;

  player.x = clamp(player.x, 24, width - 24);
  player.y = clamp(player.y, 0, seaBottom);

  // Surface oxygen refill
  if (player.y < 30) {
    player.onSurface = true;
    STATE.oxygen = Math.min(STATE.maxOxygen, STATE.oxygen + 0.8);
    // Auto end dive when on surface with full oxygen and fish in inventory
    if (STATE.oxygen >= STATE.maxOxygen * 0.99 && STATE.inventory.length > 0) {
      endDive('满载而归！');
      return;
    }
  } else {
    player.onSurface = false;
    STATE.oxygen -= 0.08;
  }

  // Death / end dive
  if (STATE.oxygen <= 0) {
    endDive('氧气耗尽！');
    return;
  }

  // Camera
  const targetCamY = clamp(player.y - height * 0.35, 0, seaBottom - height);
  camera.y += (targetCamY - camera.y) * 0.08;

  // Harpoons
  harpoons = harpoons.filter(h => {
    h.x += h.vx;
    h.y += h.vy;
    h.life--;
    for (let i = fishes.length - 1; i >= 0; i--) {
      const f = fishes[i];
      const dx = h.x - f.x;
      const dy = h.y - f.y;
      if (Math.hypot(dx, dy) < f.type.size + 8) {
        if (catchFish(f)) {
          fishes.splice(i, 1);
          createBlood(h.x, h.y);
        }
        return false;
      }
    }
    return h.life > 0;
  });

  // Auto catch with net range
  const netR = 18 + STATE.netRange;
  for (let i = fishes.length - 1; i >= 0; i--) {
    const f = fishes[i];
    if (Math.hypot(f.x - player.x, f.y - player.y) < netR) {
      if (catchFish(f)) {
        createBlood(f.x, f.y);
        fishes.splice(i, 1);
      }
    }
  }

  // Fish AI
  fishes.forEach(f => {
    f.wiggle += 0.1;
    f.x += f.vx;
    f.y += f.vy + Math.sin(f.wiggle) * 0.2;
    if (f.x < 20 || f.x > width - 20) f.vx *= -1;
    if (f.y < 60 || f.y > seaBottom - 40) f.vy *= -1;
  });

  // Respawn
  if (fishes.length < 20 && Math.random() < 0.05) {
    const y = rand(80, Math.min(seaBottom - 80, player.y + 400));
    fishes.push(createFish(y, pickFishByDepth(y)));
  }

  // Bubbles
  if (Math.random() < 0.08) {
    bubbles.push({ x: rand(0, width), y: player.y + rand(0, 200), r: rand(1, 4), vy: rand(0.5, 2) });
  }
  bubbles.forEach(b => { b.y -= b.vy; });
  bubbles = bubbles.filter(b => b.y > camera.y - 50);

  // Particles
  particles.forEach(p => { p.x += p.vx; p.y += p.vy; p.life -= 0.05; });
  particles = particles.filter(p => p.life > 0);

  updateUI();
}

function catchFish(fish) {
  if (STATE.weight + fish.type.weight > STATE.maxWeight) {
    showMessage('负重已满，快浮上水面吧！');
    return false;
  }
  STATE.inventory.push({ name: fish.type.name, value: fish.type.value, weight: fish.type.weight });
  STATE.weight += fish.type.weight;
  if (!STATE.caughtToday[fish.type.name]) STATE.caughtToday[fish.type.name] = { count: 0, value: 0 };
  STATE.caughtToday[fish.type.name].count++;
  STATE.caughtToday[fish.type.name].value += fish.type.value;
  showMessage(`捕获 ${fish.type.name} · ${fish.type.value} G`);
  return true;
}

function createBlood(x, y) {
  for (let i = 0; i < 6; i++) {
    particles.push({ x, y, vx: rand(-2, 2), vy: rand(-2, 2), life: 1, color: 'rgba(255,80,80,0.8)' });
  }
}

function updateUI() {
  oxygenFill.style.width = (STATE.oxygen / STATE.maxOxygen * 100) + '%';
  oxygenText.textContent = Math.ceil(STATE.oxygen / STATE.maxOxygen * 100) + '%';
  if (STATE.oxygen < 20) oxygenFill.style.background = '#f56565'; else oxygenFill.style.background = '';

  weightFill.style.width = (STATE.weight / STATE.maxWeight * 100) + '%';
  weightText.textContent = `${Math.floor(STATE.weight)}/${STATE.maxWeight}`;
  if (STATE.weight >= STATE.maxWeight) weightFill.style.background = '#f56565'; else weightFill.style.background = '';

  goldText.textContent = STATE.gold;
  depthText.textContent = Math.floor(player.y / 10) + 'm';
}

// Rendering
function render() {
  // Gradient water background
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#1a6b7a');
  grad.addColorStop(0.4, '#0a2f44');
  grad.addColorStop(1, '#021018');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Surface line — only draw water surface when camera is near top
  const surfaceY = -camera.y;
  if (surfaceY > -20) {
    ctx.fillStyle = '#b3e5fc';
    ctx.fillRect(0, 0, width, Math.max(0, surfaceY + 6));
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(0, Math.max(0, surfaceY + 6), width, 30);
  }

  ctx.save();
  ctx.translate(0, -camera.y);

  // Sea floor
  ctx.fillStyle = '#c2b280';
  ctx.fillRect(0, seaBottom - 40, width, 40);
  ctx.fillStyle = 'rgba(0,0,0,0.1)';
  ctx.fillRect(0, seaBottom - 30, width, 10);

  // Decorative seaweed / rocks
  ctx.fillStyle = '#2f855a';
  for (let i = 0; i < width; i += 120) {
    ctx.beginPath();
    ctx.moveTo(i + 40, seaBottom - 40);
    ctx.quadraticCurveTo(i + 60, seaBottom - 90, i + 40, seaBottom - 120);
    ctx.lineTo(i + 30, seaBottom - 40);
    ctx.fill();
  }

  // Bubbles
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  bubbles.forEach(b => {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
  });

  // Fishes
  fishes.forEach(f => drawFish(f));

  // Particles
  particles.forEach(p => {
    ctx.fillStyle = p.color;
    ctx.globalAlpha = p.life;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  });

  // Player
  drawPlayer();

  // Harpoons
  ctx.strokeStyle = '#f6e05e';
  ctx.lineWidth = 2;
  harpoons.forEach(h => {
    ctx.beginPath();
    ctx.moveTo(h.x, h.y);
    ctx.lineTo(h.x - h.vx * 0.6, h.y - h.vy * 0.6);
    ctx.stroke();
  });

  // Net range hint (faint)
  if (STATE.netRange > 0) {
    ctx.strokeStyle = 'rgba(79,209,197,0.15)';
    ctx.beginPath();
    ctx.arc(player.x, player.y, 18 + STATE.netRange, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}

function drawFish(f) {
  const { color, size, name } = f.type;
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(f.vx > 0 ? 1 : -1, 1);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, size, size * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  // tail
  ctx.beginPath();
  ctx.moveTo(-size + 4, 0);
  ctx.lineTo(-size - 8, -6);
  ctx.lineTo(-size - 8, 6);
  ctx.fill();
  // eye
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(size * 0.4, -size * 0.15, size * 0.12, 0, Math.PI * 2);
  ctx.fill();
  // name tag
  ctx.scale(f.vx > 0 ? 1 : -1, 1);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(name, 0, -size - 6);
  ctx.restore();
}

function drawPlayer() {
  ctx.save();
  ctx.translate(player.x, player.y);
  // flip toward mouse
  const flip = mouse.x < player.x ? -1 : 1;
  ctx.scale(flip, 1);

  // body
  ctx.fillStyle = '#4fd1c5';
  ctx.beginPath();
  ctx.ellipse(0, 0, 16, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  // head / helmet
  ctx.fillStyle = '#81e6d9';
  ctx.beginPath();
  ctx.arc(6, -6, 10, 0, Math.PI * 2);
  ctx.fill();
  // fins
  ctx.fillStyle = '#319795';
  ctx.beginPath();
  ctx.ellipse(-8, 4, 6, 3, 0.6, 0, Math.PI * 2);
  ctx.fill();
  // tank
  ctx.fillStyle = '#a0aec0';
  ctx.fillRect(-12, -10, 10, 16);
  // harpoon
  const angle = Math.atan2(mouse.y - (player.y - camera.y), (mouse.x - player.x) * flip);
  ctx.rotate(angle);
  ctx.strokeStyle = '#f6e05e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(10, 0);
  ctx.lineTo(26, 0);
  ctx.stroke();

  ctx.restore();
}

// Boot
ui.classList.remove('hidden');
