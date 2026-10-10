import assert from "node:assert/strict";
import { validateInBrowser } from "../server/game/browserQa";
import type { GameArtifact } from "../shared/game/types";
import { BROWSER_GAME_RUNTIME_JS } from "../shared/game/browserRuntime";

const fixture: GameArtifact = {
  title: "真实输入检查",
  description: "多文件离线按钮游戏",
  controls: ["点击按钮加分"],
  files: [
    {
      path: "index.html",
      language: "html",
      content:
        '<!doctype html><html><head><link rel="stylesheet" href="src/style.css"><script defer type="module" src="src/main.js"></script></head><body><h1>得分</h1><button id="score">0</button><img src="assets/icon.svg"></body></html>',
    },
    {
      path: "src/style.css",
      language: "css",
      content:
        "html,body{margin:0;background:#142236;color:white;height:100%;font:24px sans-serif}button{width:180px;height:90px;font-size:36px}img{width:60px}",
    },
    {
      path: "src/main.js",
      language: "javascript",
      content:
        "import {increment} from './count.js'; const button=document.querySelector('#score');let score=0;button.addEventListener('click',()=>{score=increment(score);button.textContent=String(score)});const url=new URL('../data/settings.json',import.meta.url);if(!url.href.startsWith('data:'))throw new Error('URL type lost');fetch(url).then(r=>r.json()).then(v=>{document.title=v.title});",
    },
    {
      path: "src/count.js",
      language: "javascript",
      content: "export const increment=score=>score+1;",
    },
    {
      path: "data/settings.json",
      language: "json",
      content: '{"title":"离线配置已加载"}',
    },
    {
      path: "assets/icon.svg",
      language: "text",
      content:
        '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><circle cx="30" cy="30" r="25" fill="#4ade80"/></svg>',
    },
  ],
};
const animated: GameArtifact = {
  title: "纯动画对照",
  description: "没有输入响应的动画不能通过",
  controls: [],
  files: [
    {
      path: "index.html",
      language: "html",
      content:
        '<html><body style="margin:0"><canvas width="350" height="350"></canvas><script>const canvas=document.querySelector("canvas"),ctx=canvas.getContext("2d");let x=0;function draw(){ctx.fillStyle="#142236";ctx.fillRect(0,0,350,350);ctx.fillStyle="#4ade80";ctx.fillRect((x++)%300,80,30,30);requestAnimationFrame(draw)}draw();</script></body></html>',
    },
  ],
};
const htmlFixture = (content: string): GameArtifact => ({
  ...fixture,
  files: [{ path: "index.html", language: "html", content }],
});
type SmokeCase = {
  name: string;
  artifact: GameArtifact;
  expected: "passed" | "unverified" | "failed";
  input?: "pass" | "unverified";
  surface?: "pass" | "fail";
};
const cases: SmokeCase[] = [
  {
    name: "多文件 + 模块 + CSS + SVG + JSON + 真实输入",
    artifact: fixture,
    expected: "passed",
    input: "pass",
    surface: "pass",
  },
  {
    name: "自动动画不冒充输入响应",
    artifact: animated,
    expected: "unverified",
    input: "unverified",
    surface: "pass",
  },
  {
    name: "静态按钮的原生焦点不冒充游戏逻辑",
    artifact: htmlFixture("<button>没有逻辑的按钮</button>"),
    expected: "unverified",
    input: "unverified",
    surface: "pass",
  },
  {
    name: "语法错误阻断",
    artifact: htmlFixture("<script>const x=;</script>"),
    expected: "failed",
  },
  {
    name: "启动异常捕获",
    artifact: htmlFixture(
      "<button>1</button><script>throw new Error('deliberate smoke failure')</script>"
    ),
    expected: "failed",
    input: "unverified",
    surface: "pass",
  },
  {
    name: "隐藏和裁切canvas不冒充可见界面或输入证据",
    artifact:
      htmlFixture(`<html><head><style>html,body{margin:0}canvas{width:100px;height:100px}</style></head><body>
      <canvas style="display:none"></canvas>
      <canvas style="visibility:hidden"></canvas>
      <div style="opacity:0"><canvas></canvas><button>隐藏按钮</button></div>
      <canvas style="position:absolute;left:-10000px"></canvas>
      <canvas style="clip-path:inset(50%)"></canvas>
      <canvas style="position:absolute;clip:rect(0px,0px,0px,0px)"></canvas>
      <script>let n=0;document.addEventListener('keydown',()=>{n++;document.querySelectorAll('canvas').forEach(c=>{const ctx=c.getContext('2d');ctx.fillStyle=n%2?'red':'blue';ctx.fillRect(0,0,c.width,c.height)});});</script>
      </body></html>`),
    expected: "failed",
    input: "unverified",
    surface: "fail",
  },
  {
    name: "隐藏DOM的data/class/style变更不冒充输入响应",
    artifact:
      htmlFixture(`<h1>静态界面</h1><button style="display:none">隐藏按钮</button><div id="state" hidden></div>
      <script>let n=0;document.addEventListener('keydown',()=>{const el=document.querySelector('#state');el.dataset.score=String(++n);el.className='unused-'+n;el.style.width=n+'px';el.textContent=String(n);});</script>`),
    expected: "unverified",
    input: "unverified",
    surface: "pass",
  },
  {
    name: "可见DOM的未绘制data/class/custom-property变更不冒充响应",
    artifact: htmlFixture(
      `<button id="state">静态按钮</button><script>let n=0;document.addEventListener('keydown',()=>{const el=document.querySelector('#state');el.dataset.score=String(++n);el.className='unused-'+n;el.style.setProperty('--unused',String(n));});</script>`
    ),
    expected: "unverified",
    input: "unverified",
    surface: "pass",
  },
  ...["auto", "none"].map(pointerEvents => ({
    name: `全遮挡元素变化不能通过（遮挡层pointer-events:${pointerEvents}）`,
    artifact:
      htmlFixture(`<html><head><style>body{margin:0}h1{margin:0;height:60px}.area{position:absolute;left:0;top:70px;width:300px;height:200px;background:red}.cover{z-index:10;background:white;pointer-events:${pointerEvents}}</style></head><body>
      <h1>静态可见标题</h1><div id="hidden" class="area">不可见分数0</div><div class="area cover"></div>
      <script>let n=0;document.addEventListener('keydown',()=>{n++;const el=document.querySelector('#hidden');el.textContent='不可见分数'+n;el.style.backgroundColor=n%2?'green':'blue';});</script></body></html>`),
    expected: "unverified" as const,
    input: "unverified" as const,
    surface: "pass" as const,
  })),
  {
    name: "透明文本与不透明度0开始按钮不能冒充界面或响应",
    artifact:
      htmlFixture(`<html><body style="margin:0"><div id="text" style="color:transparent">透明文本</div><button style="opacity:0" onclick="document.body.innerHTML='<h1>误点击隐藏开始按钮</h1>'">开始游戏</button>
      <script>let n=0;document.addEventListener('keydown',()=>{document.querySelector('#text').textContent='透明分数'+(++n)});</script></body></html>`),
    expected: "failed",
    input: "unverified",
    surface: "fail",
  },
  {
    name: "DOM棋盘的实际文字及背景反馈可通过",
    artifact: htmlFixture(
      `<h1>点击棋盘落子</h1><button data-cell style="width:150px;height:150px;background:#ddd" onclick="this.textContent='X';this.style.backgroundColor='lime'">空格</button>`
    ),
    expected: "passed",
    input: "pass",
    surface: "pass",
  },
  {
    name: "CSS精灵的可见位置移动可通过",
    artifact:
      htmlFixture(`<html><head><style>body{margin:0}#sprite{position:absolute;left:40px;top:150px;width:45px;height:45px;background:lime}</style></head><body><h1>按键移动方块</h1><div id="sprite"></div>
      <script>let x=40;document.addEventListener('keydown',e=>{e.preventDefault();x+=e.key==='ArrowLeft'?-10:15;document.querySelector('#sprite').style.left=x+'px'});</script></body></html>`),
    expected: "passed",
    input: "pass",
    surface: "pass",
  },
  {
    name: "同暂停时钟下自动动画和真实canvas输入共存可通过",
    artifact: htmlFixture(
      `<html><body style="margin:0"><canvas width="350" height="350"></canvas><script>const c=document.querySelector('canvas'),ctx=c.getContext('2d');let tick=0,y=80;document.addEventListener('keydown',e=>{e.preventDefault();y+=12});function draw(){ctx.fillStyle='#142236';ctx.fillRect(0,0,350,350);ctx.fillStyle='#4ade80';ctx.fillRect((tick++)%300,y,30,30);requestAnimationFrame(draw)}draw();</script></body></html>`
    ),
    expected: "passed",
    input: "pass",
    surface: "pass",
  },
  {
    name: "原生长页滚动不冒充游戏输入逻辑",
    artifact: htmlFixture(
      `<html><body style="margin:0"><h1>纯静态长页</h1><p style="height:2200px;background:linear-gradient(red,blue)">没有输入逻辑</p></body></html>`
    ),
    expected: "unverified",
    input: "unverified",
    surface: "pass",
  },
  {
    name: "ArcaneRuntime连续左右移动与blur暂停的真实canvas可通过",
    artifact: htmlFixture(
      `<html><body style="margin:0"><canvas style="width:350px;height:350px"></canvas><script>${BROWSER_GAME_RUNTIME_JS}</script><script>const game=ArcaneRuntime.createGame({canvas:document.querySelector('canvas'),reset:()=>({x:80}),update:(dt,input,data)=>{if(input.keys.has('ArrowRight'))data.x+=100*dt;if(input.keys.has('ArrowLeft'))data.x-=100*dt},render:(ctx,size,data)=>{ctx.fillStyle='#142236';ctx.fillRect(0,0,size.width,size.height);ctx.fillStyle='lime';ctx.fillRect(data?data.x:80,100,35,35)}});game.start();</script></body></html>`
    ),
    expected: "passed",
    input: "pass",
    surface: "pass",
  },
];
const selectedCases = process.env.ARCANE_QA_CASE_FILTER
  ? cases.filter(test =>
      process.env
        .ARCANE_QA_CASE_FILTER!.split("|")
        .some(part => test.name.includes(part))
    )
  : cases;
assert.ok(selectedCases.length, "at least one QA smoke case must be selected");
for (const { name, artifact, expected, input, surface } of selectedCases) {
  const report = await validateInBrowser(artifact);
  console.log(
    JSON.stringify({
      test: name,
      expected,
      actual: report.status,
      checks: report.checks,
      durationMs: report.durationMs,
    })
  );
  assert.equal(report.status, expected, name);
  if (input) {
    const inputs = report.checks.filter(check => check.id.startsWith("input-"));
    assert.equal(inputs.length, 4, `${name}: four input groups must complete`);
    for (const check of inputs)
      assert.equal(check.status, input, `${name}: ${check.id}`);
    if (name === "自动动画不冒充输入响应")
      for (const check of inputs)
        assert.ok(
          check.detail.includes("未观察到输入造成"),
          `${name}: deterministic baseline must match`
        );
  }
  if (surface) {
    const surfaces = report.checks.filter(check =>
      check.id.startsWith("surface-")
    );
    assert.equal(
      surfaces.length,
      4,
      `${name}: four surface groups must complete`
    );
    for (const check of surfaces)
      assert.equal(check.status, surface, `${name}: ${check.id}`);
  }
}
console.log(`Browser QA smoke passed: ${selectedCases.length} cases.`);
