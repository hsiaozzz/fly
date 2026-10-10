import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { BROWSER_GAME_RUNTIME_JS } from "../../shared/game/browserRuntime";

class Target {
  handlers = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, fn: (event: any) => void) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type)!.add(fn); }
  removeEventListener(type: string, fn: (event: any) => void) { this.handlers.get(type)?.delete(fn); }
  emit(type: string, event: any = {}) { for (const listener of this.handlers.get(type) ?? []) listener(event); }
}

function environment() {
  const window: any = new Target(), canvas: any = new Target(), frames = new Map<number, (time: number) => void>();
  let sequence = 0, resize: () => void = () => {};
  const rect = { left: 10, top: 20, width: 500, height: 250 };
  const ctx = { transforms: [] as number[][], setTransform(...args: number[]) { this.transforms.push(args); } };
  canvas.tabIndex = -1; canvas.getContext = () => ctx; canvas.getBoundingClientRect = () => rect; canvas.focus = () => { canvas.focused = true; };
  window.devicePixelRatio = 3;
  window.requestAnimationFrame = (fn: (time: number) => void) => { frames.set(++sequence, fn); return sequence; };
  window.cancelAnimationFrame = (id: number) => frames.delete(id);
  window.ResizeObserver = class { constructor(fn: () => void) { resize = fn; } observe() {} disconnect() { resize = () => {}; } };
  vm.runInNewContext(BROWSER_GAME_RUNTIME_JS, { window });
  function tick(time: number) { const [id, callback] = [...frames][0] ?? []; if (callback) { frames.delete(id); callback(time); } }
  return { runtime: window.ArcaneRuntime, window, canvas, ctx, rect, tick, frames, resize: () => resize() };
}

describe("optional browser runtime", () => {
  it("starts, pauses, ends and restarts with fresh game data and one frame loop", () => {
    const env = environment(), updates: number[] = [], rendered: string[] = [];
    const game = env.runtime.createGame({ canvas: env.canvas, reset: () => ({ score: 0 }), update: (dt: number, _input: any, data: any) => { updates.push(dt); data.score++; }, render: (_ctx: unknown, _size: unknown, _data: unknown, state: string) => rendered.push(state) });
    env.tick(0); expect(updates).toHaveLength(0); expect(rendered).toEqual(["ready"]);
    game.start(); env.tick(100); env.tick(1000);
    expect(game.data().score).toBe(2); expect(updates[1]).toBeCloseTo(1 / 15);
    game.pause(); env.tick(2000); expect(updates).toHaveLength(2);
    game.resume(); env.tick(3000); expect(updates.at(-1)).toBe(0);
    game.win(); env.tick(4000); expect(game.state()).toBe("won"); expect(updates).toHaveLength(3);
    game.restart(); expect(game.data().score).toBe(0); expect(game.state()).toBe("running");
    expect(env.frames.size).toBe(1); game.lose(); expect(game.state()).toBe("lost");
  });

  it("tracks keyboard edges and pointer coordinates, avoiding stuck keys after blur", () => {
    const env = environment();
    const game = env.runtime.createGame({ canvas: env.canvas, render: () => {} }); game.start();
    let prevented = 0;
    env.window.emit("keydown", { code: "Space", preventDefault: () => prevented++ });
    expect(game.input.keys.has("Space")).toBe(true); expect(game.input.pressed.has("Space")).toBe(true);
    env.tick(0); expect(game.input.pressed.has("Space")).toBe(false);
    env.window.emit("keydown", { code: "Space", repeat: true }); expect(game.input.pressed.has("Space")).toBe(false);
    env.window.emit("keydown", { code: "KeyW", target: { tagName: "INPUT" }, preventDefault: () => prevented++ });
    expect(game.input.keys.has("KeyW")).toBe(false); expect(prevented).toBe(1);
    env.canvas.emit("pointerdown", { clientX: 260, clientY: 145 });
    expect(game.input.pointer.x).toBe(250); expect(game.input.pointer.y).toBe(125); expect(env.canvas.focused).toBe(true);
    env.window.emit("blur"); expect(game.input.keys.size).toBe(0); expect(game.input.pointer.down).toBe(false); expect(game.state()).toBe("paused");
  });

  it("resizes DPR-backed canvases and removes every listener/frame on destroy", () => {
    const env = environment(), sizes: any[] = [];
    const game = env.runtime.createGame({ canvas: env.canvas, render: () => {}, onResize: (size: any) => sizes.push({ ...size }) });
    expect(env.canvas.width).toBe(1000); expect(env.canvas.height).toBe(500);
    env.rect.width = 1000; env.resize(); expect(game.size.width).toBe(1000); expect(env.canvas.width).toBe(2000);
    expect(sizes).toHaveLength(2); game.destroy(); game.destroy();
    expect(env.frames.size).toBe(0); expect(game.state()).toBe("destroyed");
    expect([...env.window.handlers.values(), ...env.canvas.handlers.values()].every(set => set.size === 0)).toBe(true);
  });

  it("stops scheduling if a gameplay callback destroys the runtime", () => {
    const env = environment(); let game: any;
    game = env.runtime.createGame({ canvas: env.canvas, update: () => game.destroy(), render: () => {} });
    game.start(); env.tick(0); expect(env.frames.size).toBe(0);
  });

  it("uses text-only HUD updates and cleans up restart buttons", () => {
    const env = environment(); let restarts = 0;
    class Element extends Target { children: Element[] = []; attrs: Record<string, string> = {}; textContent = ""; removed = false; ownerDocument: any; appendChild(element: Element) { this.children.push(element); } setAttribute(key: string, value: string) { this.attrs[key] = value; } remove() { this.removed = true; } }
    const container = new Element(); container.ownerDocument = { createElement: () => new Element() };
    const hud = env.runtime.createHud(container, { restart: () => restarts++ });
    hud.set({ score: 10, name: "<script>alert(1)</script>" });
    expect(hud.element.children[0].textContent).toBe("score: 10 · name: <script>alert(1)</script>");
    hud.show("Victory"); expect(hud.element.children[1].textContent).toBe("Victory");
    hud.element.children[2].emit("click"); expect(restarts).toBe(1);
    hud.destroy(); hud.element.children[2].emit("click"); expect(restarts).toBe(1); expect(hud.element.removed).toBe(true);
  });
});
