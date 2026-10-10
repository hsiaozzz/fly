import type { GameSpec } from "./types";

export const MOTO_GAME_SPEC: GameSpec = {
  schemaVersion: "1.0",
  game: {
    title: "Stunt Rider X",
    genre: "runner",
    orientation: "landscape",
    description: "A high-octane 2D motorcycle stunt game with realistic tilt physics, moving buzz saws, turbo pads, and time trials inspired by Moto X3M."
  },
  player: {
    type: "Motorcycle & Rider",
    movement: "Throttle & Tilt Physics",
    color: "#e63946"
  },
  mechanics: ["Throttle", "Brake", "Tilt Forward", "Tilt Backward", "Turbo Boost", "Crash & Checkpoint Respawn"],
  entities: [
    { id: "player", type: "Motorcycle" },
    { id: "obstacle", type: "BuzzSaw" },
    { id: "booster", type: "TurboPad" },
    { id: "finish", type: "FinishLine" }
  ],
  systems: ["PhysicsSystem", "ScoreSystem", "StuntTimerSystem"],
  input: ["keyboard", "touch"],
  config: {
    playerSpeed: 420,
    gravity: 1100,
    obstacleGap: 280,
    obstacleInterval: 1800,
    startingHealth: 1
  }
};
