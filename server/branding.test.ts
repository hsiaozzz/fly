import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("portable ARCANE branding", () => {
  it("ships its default SVG locally without requiring deployment environment values", () => {
    expect(readFileSync("client/public/arcane-avocado.svg", "utf8")).toContain("<svg");
    expect(readFileSync("client/src/components/GameWorkspace.tsx", "utf8")).toContain('"/arcane-avocado.svg"');
  });
});
