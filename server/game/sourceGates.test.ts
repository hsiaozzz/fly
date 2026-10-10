import { describe, expect, it } from "vitest";
import { runSourceGates, checkRenderTarget, checkGameLoop, checkInputBinding, checkScriptIntegrity, checkNoPlaceholder } from "../../shared/game/sourceGates";
import type { GameFile } from "../../shared/game/types";

const html = (content: string): GameFile => ({ path: "index.html", content, language: "html" });
const js = (content: string): GameFile => ({ path: "src/main.js", content, language: "text" });

/** A minimal artifact that passes every gate — tests mutate it to fail one. */
function playableGame(): GameFile[] {
  return [html(`<!doctype html><html><head><style>canvas{width:100vw;height:100vh}</style></head><body>
<canvas id="game"></canvas><script>
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
let score = 0;
function loop(){ requestAnimationFrame(loop); ctx.fillText("Score: " + score, 10, 10); }
loop();
addEventListener("keydown", e => { score++; });
addEventListener("pointerdown", () => { score++; });
</script></body></html>`)];
}

describe("sourceGates", () => {
  it("passes every gate for a complete game", () => {
    const report = runSourceGates(playableGame());
    const failed = report.checks.filter(check => check.status === "fail");
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails when there is no canvas or render container", () => {
    const files = playableGame().filter(file => file.path !== "index.html");
    files.push(html("<html><body><p>no canvas here</p></body></html>"));
    expect(checkRenderTarget(files).status).toBe("fail");
  });

  it("fails when there is no animation loop", () => {
    const files = [html("<html><body><canvas></canvas><script>ctx.fillRect(0,0,10,10);</script></body></html>")];
    expect(checkGameLoop(files).status).toBe("fail");
  });

  it("fails when there is no input listener anywhere", () => {
    const files = [html("<html><body><canvas></canvas><script>requestAnimationFrame(function loop(){requestAnimationFrame(loop);});</script></body></html>")];
    expect(checkInputBinding(files).status).toBe("fail");
  });

  it("reads input handlers from sibling js files, not just index.html", () => {
    const files = [
      html("<html><body><canvas></canvas><script src='src/main.js'></script></body></html>"),
      js("requestAnimationFrame(function loop(){requestAnimationFrame(loop);}); document.addEventListener('keydown', () => {});"),
    ];
    expect(checkInputBinding(files).status).toBe("pass");
    expect(checkGameLoop(files).status).toBe("pass");
  });

  it("detects an unescaped </script> inside inline JS", () => {
    const files = [html("<html><body><script>const a = \"</script>\"; const b = 1;</script></body></html>")];
    const result = checkScriptIntegrity(files);
    expect(result.status).toBe("fail");
    expect(result.hint).toBeTruthy();
  });

  it("detects an unclosed script tag", () => {
    const files = [html("<html><body><script>const a = 1;</body></html>")];
    expect(checkScriptIntegrity(files).status).toBe("fail");
  });

  it("accepts properly escaped script-closing sequences", () => {
    const files = [html("<html><body><script>const a = \"<\\/script>\";</script></body></html>")];
    expect(checkScriptIntegrity(files).status).toBe("pass");
  });

  it("warns on TODO prose without treating comments as missing gameplay", () => {
    const files = [html("<html><body><canvas></canvas><script>// TODO implement game\nrequestAnimationFrame(function loop(){requestAnimationFrame(loop);});document.addEventListener('keydown',()=>{});</script></body></html>")];
    expect(checkNoPlaceholder(files).status).toBe("warn");
  });

  it("reports warnings without blocking", () => {
    const files = [html("<html><body><canvas width='800' height='600'></canvas><script>requestAnimationFrame(function loop(){requestAnimationFrame(loop);});document.addEventListener('keydown',()=>{});</script></body></html>")];
    const report = runSourceGates(files);
    // No HUD text, fixed canvas, no end condition: warnings, not failures.
    expect(report.ok).toBe(true);
    expect(report.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("collects all failures at once instead of stopping at the first", () => {
    const files = [html("<html><body><p>empty</p></body></html>")];
    const report = runSourceGates(files);
    const failed = report.checks.filter(check => check.status === "fail").map(check => check.name);
    expect(failed).toEqual(expect.arrayContaining(["render_target", "game_loop", "input_binding"]));
  });

  it("does not mistake comments or strings for executable behavior", () => {
    const files = [html(`<body><!-- <canvas> --><script>// requestAnimationFrame(loop); addEventListener('keydown',()=>{});
const description="requestAnimationFrame(loop); addEventListener('keydown',()=>{}); <canvas>";</script></body>`)];
    expect(checkInputBinding(files).status).toBe("fail");
    expect(checkGameLoop(files).status).toBe("fail");
    expect(checkRenderTarget(files).status).toBe("fail");
  });

  it("accepts event-driven DOM games without requiring an animation loop", () => {
    const files = [html(`<body><button id="counter">0</button><script>let score=0;const button=document.querySelector('#counter');button.addEventListener('click',()=>button.textContent=++score);</script></body>`)];
    expect(checkRenderTarget(files).status).toBe("pass");
    expect(checkGameLoop(files).status).toBe("pass");
    expect(checkInputBinding(files).status).toBe("pass");
  });

  it("ignores unreferenced sibling scripts and reports missing references", () => {
    const files = [html(`<body><canvas></canvas><script src="missing.js"></script></body>`), js(`requestAnimationFrame(()=>{});addEventListener('keydown',()=>{});`)];
    expect(checkInputBinding(files).status).toBe("fail");
    expect(checkGameLoop(files).status).toBe("fail");
    expect(checkScriptIntegrity(files).status).toBe("fail");
  });

  it("follows real input callbacks into canvas drawing, excluding unrelated draws", () => {
    const eventGame = [html(`<body><canvas></canvas><script>const ctx=document.querySelector('canvas').getContext('2d');function draw(){ctx.fillRect(0,0,10,10);}addEventListener('click',()=>draw());</script></body>`)];
    expect(checkGameLoop(eventGame).status).toBe("pass");
    const missingUpdate = [html(`<body><canvas></canvas><script>const ctx=document.querySelector('canvas').getContext('2d');function draw(){ctx.fillRect(0,0,10,10);}addEventListener('click',()=>{let score=1; const ignored=draw;});</script></body>`)];
    expect(checkGameLoop(missingUpdate).status).toBe("fail");
  });
});
