import { describe, expect, it } from "vitest";
import vm from "node:vm";
import ts from "typescript";
import { compileGameProject } from "../../shared/game/compiler";
import { normalizeGameSpec } from "../../shared/game/gamespec";

function compiledScene(genre: "runner" | "shooter" | "flappy") {
  const files = compileGameProject(normalizeGameSpec({ game: { genre } }));
  function evaluate(path: string, dependencies: Record<string, unknown>) {
    const file = files.find(file => file.path === path)!;
    const js = ts.transpileModule(file.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports: Record<string, any> = {};
    vm.runInNewContext(js, { exports, require: (name: string) => dependencies[name] });
    return exports;
  }
  class Sprite {
    x: number; y: number; rotation = 0; immovable = false;
    body = { velocity: { x: 0, y: 0 }, touching: { down: true }, blocked: { down: true }, allowGravity: true, setAllowGravity: (value: boolean) => { this.body.allowGravity = value; }, setVelocityX: (value: number) => { this.body.velocity.x = value; }, setVelocityY: (value: number) => { this.body.velocity.y = value; } };
    constructor(_scene: unknown, x: number, y: number) { this.x = x; this.y = y; }
    setVelocityX(value: number) { this.body.setVelocityX(value); return this; }
    setVelocityY(value: number) { this.body.setVelocityY(value); return this; }
    setVelocity(x: number, y = x) { this.setVelocityX(x); this.setVelocityY(y); return this; }
    setImmovable(value: boolean) { this.immovable = value; return this; }
    setCollideWorldBounds(_value: boolean) { return this; }
    setGravityY(_value: number) { return this; }
    setCircle() { return this; }
    destroy() {}
  }
  const groups: any[] = [], handlers = new Map<string, () => void>();
  function group() { const children: Sprite[] = []; const value = { create: (x: number, y: number) => { const sprite = new Sprite(null, x, y); children.push(sprite); return sprite; }, getChildren: () => children, add: () => {} }; groups.push(value); return value; }
  class Scene {
    bounds: number[] = [];
    physics = { world: { gravity: { y: 0 }, setBounds: (...values: number[]) => { this.bounds = values; } }, pause: () => {}, add: { group, staticGroup: group, existing: () => {}, collider: () => {}, overlap: () => {}, sprite: (x: number, y: number) => new Sprite(null, x, y) } };
    add = { text: () => ({ setText() { return this; }, setScrollFactor() { return this; } }), graphics: () => ({ fillGradientStyle: () => {}, fillRect: () => {} }), rectangle: () => ({}) };
    input = { on: (name: string, fn: () => void) => handlers.set(name, fn), keyboard: { on: (name: string, fn: () => void) => handlers.set(name, fn), createCursorKeys: () => ({ left: {}, right: {}, up: {}, down: {} }), addKeys: () => ({ W: {}, A: {}, S: {}, D: {} }) } };
    time = { addEvent: () => {} }; scene = { start: () => {} };
    cameras = { main: { startFollow: () => {}, setBounds: () => {} } };
  }
  const score = evaluate("src/systems/ScoreSystem.ts", {});
  const config = evaluate("src/config/game.config.ts", {});
  const { GameScene } = evaluate("src/scenes/GameScene.ts", { phaser: { Scene, Math: { Between: () => 220, Linear: (a: number, b: number, t: number) => a + (b - a) * t } }, "../entities/Player": { Player: Sprite }, "../systems/ScoreSystem": score, "../config/game.config": config });
  return { scene: new GameScene(), groups, handlers };
}

describe("maintained Phaser compiler", () => {
  it.each(["runner", "shooter", "flappy"] as const)("resets finished state and score when %s scene restarts", genre => {
    const { scene } = compiledScene(genre); scene.create(); scene.score.add(5); scene.finishGame();
    expect(scene.ended).toBe(true); scene.create();
    expect(scene.ended).toBe(false); expect(scene.score.value).toBe(0);
  });

  it("gives the runner a world large enough to reach the finish and a grounded jump", () => {
    const { scene, handlers } = compiledScene("runner"); scene.create();
    expect(scene.bounds[2]).toBeGreaterThan(4800); handlers.get("keydown-SPACE")!();
    expect(scene.player.body.velocity.y).toBeLessThan(0);
    scene.player.x = 4900; scene.update(); expect(scene.ended).toBe(true);
  });

  it("keeps flappy pipe obstacles from falling under the world's gravity", () => {
    const { scene, groups } = compiledScene("flappy"); scene.create(); scene.spawnPipes();
    expect(groups[0].getChildren()).toHaveLength(2);
    expect(groups[0].getChildren().every((pipe: any) => pipe.body.allowGravity === false)).toBe(true);
  });
});
