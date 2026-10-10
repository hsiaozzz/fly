import { describe, expect, it } from "vitest";
import { createExampleArtifact } from "../../shared/game/exampleArtifact";
import { artifactDigest, validateArtifact } from "../../shared/game/artifact";
import { bundleGameArtifact } from "../../shared/game/bundle";

describe("hand-authored offline playable example", () => {
  it("provides a valid editable artifact with an explicit preset origin", () => {
    const artifact = createExampleArtifact();
    expect(validateArtifact(artifact)).toMatchObject({ valid: true, errors: [] });
    expect(artifact.description).toContain("手工预置");
    expect(artifact.description).toContain("不代表真实 AI 生成质量");
    expect(artifact.files.map(file => file.path)).toEqual(["index.html", "style.css", "game.js"]);
  });

  it("bundles the full local dependency graph under the existing offline rules", () => {
    const artifact = createExampleArtifact();
    const { html } = bundleGameArtifact(artifact);
    expect(html).toContain('id="game-canvas"');
    expect(html).toContain('id="caught"');
    expect(html).toContain('id="missed"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    for (const file of artifact.files) expect(file.content).not.toMatch(/(?:https?:\/\/|fetch\s*\(|eval\s*\(|new\s+Function\s*\()/);
    const resources = [...html.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/g)];
    expect(resources.length).toBeGreaterThan(0);
    for (const [, resource] of resources) expect(resource).toMatch(/^data:/);
    expect(html).not.toMatch(/(?:src|href)=["'](?:game\.js|style\.css)["']/);
  });

  it("returns independent snapshots with stable whole-artifact hashes", async () => {
    const first = createExampleArtifact(), second = createExampleArtifact();
    expect(await artifactDigest(first)).toBe(await artifactDigest(second));
    first.controls[0] = "local edit";
    first.files[0].content += "<!-- local edit -->";
    first.files.push({ path: "notes.md", content: "local notes", language: "markdown" });
    expect(second).toEqual(createExampleArtifact());
    expect(await artifactDigest(first)).not.toBe(await artifactDigest(second));
  });
});
