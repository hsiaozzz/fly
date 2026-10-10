import Ajv from "ajv";
import GAME_SPEC_SCHEMA from "../../spec/gamespec.schema.json";
import type { GameSpec, SupportedGameType, GameData } from "./types";
import { DEFAULT_JOURNEY_DATA, JOURNEY_DATA_SCHEMA } from "./journeyData";

export const GAME_SPEC_JSON_SCHEMA = GAME_SPEC_SCHEMA;

const ajv = new Ajv({ allErrors: true });
const validator = ajv.compile(GAME_SPEC_JSON_SCHEMA);
const dataValidator = ajv.compile<GameData>(JOURNEY_DATA_SCHEMA);

const GAME_DEFAULTS: Record<SupportedGameType, Omit<GameSpec, "game">> = {
  flappy: {
    schemaVersion: "1.0",
    player: { type: "bird", movement: "flap", color: "#45a3ff" },
    mechanics: ["gravity", "flap", "obstacle", "collision", "score", "restart"],
    entities: [{ id: "player", type: "bird" }, { id: "pipe", type: "obstacle" }],
    systems: ["physics", "collision", "score", "game_over"],
    input: ["mouse", "touch", "keyboard"],
    config: { playerSpeed: 320, gravity: 980, obstacleGap: 180, obstacleInterval: 1650, startingHealth: 1 },
  },
  shooter: {
    schemaVersion: "1.0",
    player: { type: "ship", movement: "eight_direction", color: "#60a5fa" },
    mechanics: ["movement", "shoot", "enemy", "collision", "health", "score"],
    entities: [{ id: "player", type: "ship" }, { id: "enemy", type: "enemy" }, { id: "bullet", type: "projectile" }],
    systems: ["physics", "spawn", "collision", "score", "game_over"],
    input: ["mouse", "touch", "keyboard"],
    config: { playerSpeed: 310, gravity: 0, obstacleGap: 220, obstacleInterval: 1150, startingHealth: 3 },
  },
  runner: {
    schemaVersion: "1.0",
    player: { type: "runner", movement: "jump", color: "#fbbf24" },
    mechanics: ["run", "jump", "scrolling", "obstacle", "collision", "score"],
    entities: [{ id: "player", type: "runner" }, { id: "obstacle", type: "obstacle" }],
    systems: ["physics", "spawn", "collision", "score", "game_over"],
    input: ["mouse", "touch", "keyboard"],
    config: { playerSpeed: 360, gravity: 1350, obstacleGap: 220, obstacleInterval: 1450, startingHealth: 1 },
  },
  journey: {
    schemaVersion: "1.0",
    player: { type: "rider", movement: "gallop", color: "#c8a165" },
    mechanics: ["ride", "gear", "jump", "stamina", "weather", "encounter", "choice", "trade", "codex", "ending"],
    entities: [
      { id: "player", type: "rider" },
      { id: "horse", type: "mount" },
      { id: "obstacle", type: "hazard" },
      { id: "pickup", type: "resource" },
      { id: "node", type: "waypoint" },
    ],
    systems: ["riding", "stamina", "terrain", "weather", "schedule", "survival", "encounter", "choice", "bond", "inventory", "trade", "renown", "codex", "ending", "save"],
    input: ["keyboard", "mouse", "touch"],
    config: { playerSpeed: 240, gravity: 1200, obstacleGap: 200, obstacleInterval: 2200, startingHealth: 5 },
    data: DEFAULT_JOURNEY_DATA,
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function selectedGenre(value: unknown): SupportedGameType {
  return value === "shooter" || value === "runner" || value === "flappy" || value === "journey" ? value : "flappy";
}

function text(value: unknown, fallback: string, max = 500): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function numberWithin(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

/** 旅程数据：缺失或畸形时回落默认《长风万里》数据，保证引擎永远有内容可跑。 */
function journeyData(value: unknown, fallback: GameData): GameData {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<GameData>) : undefined;
  if (!source || !dataValidator(source)) return fallback;
  const unique = (items: { id: string }[]) => new Set(items.map(item => item.id)).size === items.length;
  if ([source.regions, source.nodes, source.events, source.endings, source.quests ?? [], source.secrets ?? []].some(items => !unique(items))) return fallback;
  const regionIds = new Set(source.regions!.map(region => region.id));
  const nodeIds = new Set(source.nodes!.map(node => node.id));
  if (regionIds.size !== source.regions!.length || nodeIds.size !== source.nodes!.length || source.nodes!.some(node => !regionIds.has(node.region)) || source.quests?.some(quest => !nodeIds.has(quest.node)) || source.events!.some(event => event.region && !regionIds.has(event.region)) || source.secrets?.some(secret => secret.region && !regionIds.has(secret.region))) return fallback;
  return { ...source, start: { ...(fallback.start ?? {}), ...(source.start ?? {}) } } as GameData;
}

export function normalizeGameSpec(input: unknown): GameSpec {
  const source = asRecord(input);
  const gameInput = asRecord(source.game);
  const genre = selectedGenre(gameInput.genre);
  const defaults = GAME_DEFAULTS[genre];
  const configInput = asRecord(source.config);
  const playerInput = asRecord(source.player);
  const color = text(playerInput.color, defaults.player.color);
  const validColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : defaults.player.color;
  const strings = (value: unknown, fallback: string[]) => { const result = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, 12) : []; return result.length ? result : fallback; };
  const entities = Array.isArray(source.entities) ? source.entities.map(asRecord).filter(item => typeof item.id === "string" && typeof item.type === "string").slice(0, 16).map(item => ({ id: String(item.id), type: String(item.type) })) : [];
  const inputs = Array.isArray(source.input) ? source.input.filter((item): item is GameSpec["input"][number] => item === "mouse" || item === "touch" || item === "keyboard") : [];


  return {
    schemaVersion: "1.0",
    game: {
      title: text(gameInput.title, genre === "flappy" ? "Skybound" : genre === "shooter" ? "Starfall Patrol" : genre === "journey" ? "长风万里" : "Neon Sprint", 80),
      genre,
      orientation: gameInput.orientation === "portrait" ? "portrait" : "landscape",
      description: text(gameInput.description, `A ${genre} game generated from a validated GameSpec.`),
    },
    player: {
      type: text(playerInput.type, defaults.player.type),
      movement: text(playerInput.movement, defaults.player.movement),
      color: validColor,
    },
    mechanics: strings(source.mechanics, defaults.mechanics),
    entities: entities.length ? entities : defaults.entities,
    systems: strings(source.systems, defaults.systems),
    input: inputs.length ? inputs : defaults.input,
    config: {
      playerSpeed: numberWithin(configInput.playerSpeed, defaults.config.playerSpeed, 80, 900),
      gravity: numberWithin(configInput.gravity, defaults.config.gravity, 0, 2400),
      obstacleGap: numberWithin(configInput.obstacleGap, defaults.config.obstacleGap, 80, 600),
      obstacleInterval: numberWithin(configInput.obstacleInterval, defaults.config.obstacleInterval, 500, 6000),
      startingHealth: Math.round(numberWithin(configInput.startingHealth, defaults.config.startingHealth, 1, 20)),
    },
    ...(defaults.data ? { data: journeyData(source.data, defaults.data) } : {}),
  };
}

export function validateGameSpec(input: unknown) {
  const valid = validator(input);
  return { valid: Boolean(valid), errors: validator.errors?.map(error => `${error.instancePath || "/"} ${error.message || "invalid"}`) ?? [] };
}

export function gameSpecFromPrompt(prompt: string): GameSpec {
  const normalized = prompt.toLowerCase();
  const genre: SupportedGameType = /shooter|shoot|飞机|射击|战机|飞船/.test(normalized)
    ? "shooter"
    : /runner|run|跑酷|奔跑|冲刺/.test(normalized)
      ? "runner"
      : /journey|ride|horse|骑马|环游|旅行|征程|游历|马|骑/.test(normalized)
        ? "journey"
        : "flappy";
  const title = genre === "flappy" ? "Bluebird Passage" : genre === "shooter" ? "Skyline Defender" : genre === "journey" ? "长风万里" : "Velocity Runner";
  const spec = normalizeGameSpec({ game: { title, genre, description: prompt } });
  if (/蓝色|blue/.test(normalized)) spec.player.color = "#45a3ff";
  if (/快速|提高.*速度|speed up/.test(normalized)) spec.config.playerSpeed = Math.min(900, spec.config.playerSpeed * 1.25);
  if (/间距.*大|gap.*larger|更大/.test(normalized)) spec.config.obstacleGap = Math.min(600, spec.config.obstacleGap + 60);
  return spec;
}
