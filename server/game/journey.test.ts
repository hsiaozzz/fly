import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { JOURNEY_ENGINE_JS, journeyShell } from "../../shared/game/journeyEngine";
import { DEFAULT_JOURNEY_DATA, JOURNEY_DATA_SCHEMA } from "../../shared/game/journeyData";
import { GAME_SPEC_JSON_SCHEMA, normalizeGameSpec, validateGameSpec } from "../../shared/game/gamespec";
import schema from "../../spec/gamespec.schema.json";

function runtime() {
  const noop = () => {}, context = new Proxy({ measureText: () => ({ width: 12 }), createLinearGradient: () => ({ addColorStop: noop }) }, { get: (object: any, key) => key in object ? object[key] : noop, set: (object, key, value) => { (object as any)[key] = value; return true; } });
  const canvas = { style: {}, width: 960, height: 540, getContext: () => context, addEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }) };
  const sandbox: any = { window: { __JOURNEY_DATA__: DEFAULT_JOURNEY_DATA, addEventListener: noop, devicePixelRatio: 1 }, document: { title: "旅行", getElementById: () => canvas }, requestAnimationFrame: noop, setTimeout: noop };
  vm.runInNewContext(JOURNEY_ENGINE_JS, sandbox);
  const game = sandbox.window.__JOURNEY__;
  const key = (code: string) => { game.key(code); game.step(0); };
  const click = (label: string) => { game.step(0); const clicked = game.click(label); game.step(0); return clicked; };
  key("Enter"); click("上马，向西。"); key("Enter");
  return { game, key, click };
}

describe("journey source and schema", () => {
  it("uses one canonical schema including quests and secrets", () => {
    expect(GAME_SPEC_JSON_SCHEMA).toBe(schema);
    expect(JOURNEY_DATA_SCHEMA).toBe(schema.properties.data);
    const spec = normalizeGameSpec({ game: { genre: "journey", title: "t".repeat(90) }, mechanics: [1], systems: [null], entities: [null], input: ["invalid"], data: { regions: [], nodes: [], events: [], endings: [] } });
    expect(validateGameSpec(spec).valid).toBe(true);
    expect(spec.game.title).toHaveLength(80);
    expect(spec.data?.nodes.length).toBe(DEFAULT_JOURNEY_DATA.nodes.length);
  });

  it("escapes inline data so text cannot close its script element", () => {
    const html = journeyShell("<test>&", JSON.stringify({ text: "</script><script>alert(1)</script>" }), JOURNEY_ENGINE_JS);
    expect(html).toContain("&lt;test&gt;&amp;");
    expect(html.match(/<script>/g)).toHaveLength(2);
    expect(html).toContain("\\u003c/script>");
    expect(() => new vm.Script(JOURNEY_ENGINE_JS)).not.toThrow();
  });

  it("returns from the codex to the actual map scene before any ride", () => {
    const { game, key } = runtime();
    expect(game.state().scene).toBe("map"); key("KeyC"); expect(game.state().scene).toBe("codex"); key("Escape");
    expect(game.state().scene).toBe("map"); expect(() => game.step(0)).not.toThrow();
  });

  it("runs actual data-driven quests once and returns to their node", () => {
    const { game, click, key } = runtime();
    click("落脚休整"); click("接个委托");
    const quest = DEFAULT_JOURNEY_DATA.quests!.find(quest => quest.node === DEFAULT_JOURNEY_DATA.nodes[0].id)!;
    expect(click(quest.title)).toBe(true);
    const initialCoin = game.state().stats.coin;
    expect(click(quest.choices[0].label)).toBe(true);
    expect(game.state().stats.coin).toBe(initialCoin + (quest.choices[0].effects.coin ?? 0));
    key("Enter"); expect(game.state().scene).toBe("node");
    expect(game.state().seen[`q:${quest.id}`]).toBe(true);
    click("接个委托"); expect(click(quest.title)).toBe(false);
  });

  it("resolves numeric threat choices without silently changing speed", () => {
    const { game, key } = runtime(); key("Digit2");
    const ride = game.state().ride; ride.threat = { obj: { type: "wolf", done: false } };
    const gear = ride.gear; key("Digit1");
    expect(ride.threat).toBeNull(); expect(ride.gear).toBe(gear);
    game.step(1 / 60); expect(Number.isFinite(ride.hoofT)).toBe(true);
  });
});
