import { describe, expect, it } from "vitest";
import { createGameDesign, readGameDesign, reviseGameDesign, validateGameDesign } from "../../shared/game/design";

describe("user gameplay requirements", () => {
  it("retains exact object/action/count requests and separates inferred defaults", () => {
    const prompt = "使用鼠标移动篮子接住10个苹果，只有3条命。";
    const design = createGameDesign(prompt);
    expect(design.coreLoop.request).toBe(prompt);
    expect(design.acceptance.some(item => item.value === 10 && item.requirement.includes("苹果"))).toBe(true);
    expect(design.acceptance.some(item => item.value === 3 && item.requirement.includes("条命"))).toBe(true);
    expect(design.acceptance.some(item => item.kind === "controls" && item.target === "鼠标")).toBe(true);
    expect(design.acceptance.every(item => item.source === "user")).toBe(true);
    expect(design.acceptance.some(item => /暗色|dark|canvas/i.test(item.requirement))).toBe(false);
    expect(validateGameDesign(design).valid).toBe(true);
  });

  it("keeps original acceptance criteria and records later edits", () => {
    const original = createGameDesign("点击消除10个方块");
    const revised = reviseGameDesign(original, "改成20个方块");
    expect(revised.originalPrompt).toBe(original.originalPrompt);
    expect(revised.acceptance.slice(0, original.acceptance.length)).toEqual(original.acceptance);
    expect(revised.changeRequests).toEqual(["改成20个方块"]);
    expect(original.changeRequests).toEqual([]);
  });

  it("rejects malformed or duplicated saved contracts", () => {
    const design = createGameDesign("点击游戏");
    expect(validateGameDesign({ ...design, acceptance: [...design.acceptance, design.acceptance[0]] }).valid).toBe(false);
    expect(readGameDesign([{ path: "arcane.design.json", content: '{"schemaVersion":"1.0","acceptance":[]}' }])).toBeNull();
    expect(readGameDesign([{ path: "arcane.design.json", content: JSON.stringify(design) }])).toEqual(design);
  });
});
