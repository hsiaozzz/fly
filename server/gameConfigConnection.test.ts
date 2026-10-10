import { describe, expect, it } from "vitest";
import { gameConfigIsConnected } from "../client/src/lib/gameConfigConnection";
import type { GameArtifact } from "../shared/game/types";

const config = {
  schemaVersion: 1,
  parameters: [
    { id: "speed", label: "速度", type: "number", value: 3, min: 1, max: 10 },
  ],
};
const game = (
  script: string,
  extra: GameArtifact["files"] = []
): GameArtifact => ({
  title: "Config fixture",
  description: "",
  controls: [],
  files: [
    {
      path: "index.html",
      language: "html",
      content: `<html><body><script>${script}</script></body></html>`,
    },
    {
      path: "arcane.config.json",
      language: "json",
      content: JSON.stringify(config),
    },
    ...extra,
  ],
});

describe("game configuration connection", () => {
  it("recognizes executable config loading and parameter access", () => {
    expect(
      gameConfigIsConnected(
        game(
          "fetch('./arcane.config.json', {method:'GET'}).then(r=>r.json()).then(config=>console.log(config.parameters[0].value))"
        )
      )
    ).toBe(true);
    const external = game("");
    external.files[0].content =
      '<html><body><script src="game.js"></script></body></html>';
    external.files.push({
      path: "game.js",
      language: "javascript",
      content:
        "fetch('arcane.config.json').then(r=>r.json()).then(({parameters})=>console.log(parameters))",
    });
    expect(gameConfigIsConnected(external)).toBe(true);
  });
  it("rejects comments, documentation, unused scripts and loading without consumption", () => {
    expect(
      gameConfigIsConnected(
        game(
          "// fetch('arcane.config.json'); config.parameters\nconsole.log('nothing')"
        )
      )
    ).toBe(false);
    expect(
      gameConfigIsConnected(
        game("console.log('nothing')", [
          {
            path: "unused.js",
            language: "javascript",
            content:
              "fetch('arcane.config.json').then(r=>r.json()).then(config=>console.log(config.parameters))",
          },
        ])
      )
    ).toBe(false);
    expect(
      gameConfigIsConnected(
        game("fetch('arcane.config.json').then(r=>r.json())")
      )
    ).toBe(false);
    expect(
      gameConfigIsConnected(
        game("console.log('fetch(arcane.config.json) config.parameters')")
      )
    ).toBe(false);
  });
});
