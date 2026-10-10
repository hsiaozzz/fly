import type { GameSpec, SupportedGameType } from "./types";

/**
 * Semantic gates for GameSpec.
 *
 * JSON Schema (see `gamespec.ts`) answers "is this the right shape?".
 * These gates answer the question that actually decides whether a generated
 * game runs: "does this describe a playable game?"
 *
 * A spec can be schema-perfect and still be unplayable — a flappy bird with
 * gravity 0 never falls, a shooter with no `shoot` mechanic has no verb, and
 * pipes spaced closer than the gap they leave cannot be flown through.
 * None of that is a type error, which is exactly why it survives validation.
 *
 * Modelled on `operators/gen_3d_object/funcs/code_asset.py` (GameFactory-3A):
 * one function per gate, each returning `{ name, failures, warnings }`, and
 * every gate runs even after another has failed.
 */

export type GateResult = {
  name: string;
  failures: string[];
  warnings: string[];
};

export type GateReport = {
  ok: boolean;
  reports: GateResult[];
  failures: string[];
  warnings: string[];
};

/** Mechanics a genre cannot be played without. Anything less has no verb. */
const REQUIRED_MECHANICS: Record<SupportedGameType, string[]> = {
  flappy: ["flap", "gravity", "obstacle", "collision"],
  shooter: ["movement", "shoot", "enemy", "collision"],
  runner: ["run", "jump", "obstacle", "collision"],
  journey: ["ride", "jump", "stamina", "choice"],
};

/**
 * Systems a mechanic cannot work without. Missing one is a silent no-op:
 * collision detection that never registers, a score that never increments.
 */
const REQUIRED_SYSTEMS: Record<string, string> = {
  collision: "collision",
  score: "score",
};

/**
 * Systems a mechanic usually needs, where the engine may legitimately provide
 * the behaviour another way (a fixed obstacle course needs no spawner).
 * Reported as a warning, because guessing here would fail the maintained
 * templates that ship without a spawn system.
 */
const EXPECTED_SYSTEMS: Record<string, string> = {
  obstacle: "spawn",
  enemy: "spawn",
  scrolling: "spawn",
  health: "game_over",
};

/** A player cannot fit through a gap narrower than this (pixels). */
const MIN_PASSABLE_GAP = 100;

/** Below this, the gap is technically passable but feels unfair. */
const COMFORTABLE_GAP = 140;

function has(collection: string[], value: string): boolean {
  return collection.some(item => item.toLowerCase() === value);
}

/** Genre needs its verbs; a game with no verb is a screensaver. */
export function checkGenreMechanics(spec: GameSpec): GateResult {
  const required = REQUIRED_MECHANICS[spec.game.genre] ?? [];
  const owned = spec.mechanics.map(item => item.toLowerCase());
  const missing = required.filter(item => !owned.includes(item));
  return {
    name: "genre_mechanics",
    failures: missing.length
      ? [`${spec.game.genre} requires mechanic(s) ${missing.join(", ")}; without them the game has no core interaction`]
      : [],
    warnings: [],
  };
}

/** Every engine looks the player up by id. A spec without one compiles to nothing. */
export function checkPlayerEntity(spec: GameSpec): GateResult {
  const ids = spec.entities.map(entity => entity.id.toLowerCase());
  if (!ids.includes("player")) {
    return {
      name: "player_entity",
      failures: ["entities must include an entry with id 'player'; the runtime resolves the controllable actor by id"],
      warnings: [],
    };
  }
  const duplicated = spec.entities.length !== new Set(ids).size;
  return {
    name: "player_entity",
    failures: [],
    warnings: duplicated ? ["entities contain duplicate ids; later lookups will shadow earlier ones"] : [],
  };
}

/** Gravity is what makes a flappy fall and a runner come back down. */
export function checkGravityCoherence(spec: GameSpec): GateResult {
  const { gravity } = spec.config;
  const needsGravity = spec.game.genre === "flappy" || spec.game.genre === "runner";
  if (needsGravity && gravity <= 0) {
    return {
      name: "gravity_coherence",
      failures: [`${spec.game.genre} needs gravity > 0 or the player never comes down (got ${gravity})`],
      warnings: [],
    };
  }
  const jumps = has(spec.mechanics, "jump") || has(spec.mechanics, "flap");
  if (jumps && gravity <= 0) {
    return {
      name: "gravity_coherence",
      failures: [`mechanics declare a jump/flap but gravity is ${gravity}; the jump would never resolve`],
      warnings: [],
    };
  }
  return { name: "gravity_coherence", failures: [], warnings: [] };
}

/** A gap the player cannot fit through is an unwinnable game, not a hard one. */
export function checkGapViability(spec: GameSpec): GateResult {
  const { obstacleGap } = spec.config;
  const failures: string[] = [];
  const warnings: string[] = [];
  if (obstacleGap < MIN_PASSABLE_GAP) {
    failures.push(`obstacleGap ${obstacleGap}px is narrower than the player can pass (minimum ${MIN_PASSABLE_GAP}px)`);
  } else if (obstacleGap < COMFORTABLE_GAP) {
    warnings.push(`obstacleGap ${obstacleGap}px is passable but tight; expect a frustrating first run`);
  }
  return { name: "gap_viability", failures, warnings };
}

/**
 * Obstacles must be far enough apart *in space*, not just in time.
 *
 * Flown distance between two obstacles is `playerSpeed * obstacleInterval`.
 * When that distance is not comfortably larger than the gap inside each
 * obstacle, the level becomes a wall with holes nobody can thread.
 */
export function checkSpacingViability(spec: GameSpec): GateResult {
  const { playerSpeed, obstacleInterval, obstacleGap } = spec.config;
  const spacing = (playerSpeed * obstacleInterval) / 1000;
  const needed = obstacleGap * 1.5;
  if (spacing < needed) {
    return {
      name: "spacing_viability",
      failures: [
        `obstacles are ${Math.round(spacing)}px apart at ${playerSpeed}px/s every ${obstacleInterval}ms, ` +
        `which is closer than ${Math.round(needed)}px (1.5x the ${obstacleGap}px gap); raise obstacleInterval or lower playerSpeed`,
      ],
      warnings: [],
    };
  }
  return { name: "spacing_viability", failures: [], warnings: [] };
}

/** A mechanic whose supporting system is absent compiles to a silent no-op. */
export function checkSystemsCoverage(spec: GameSpec): GateResult {
  const owned = new Set(spec.systems.map(item => item.toLowerCase()));
  const missing: string[] = [];
  const advised: string[] = [];
  for (const mechanic of spec.mechanics) {
    const key = mechanic.toLowerCase();
    const required = REQUIRED_SYSTEMS[key];
    if (required && !owned.has(required)) missing.push(`${mechanic} needs system '${required}'`);
    const expected = EXPECTED_SYSTEMS[key];
    if (expected && !owned.has(expected)) advised.push(`${mechanic} usually pairs with system '${expected}'`);
  }
  return {
    name: "systems_coverage",
    failures: missing.length ? [`${missing.join("; ")}; the mechanic would do nothing at runtime`] : [],
    warnings: advised.length ? [`${advised.join("; ")}`] : [],
  };
}

/** No input device means no player, whatever else the spec claims. */
export function checkInputViability(spec: GameSpec): GateResult {
  return {
    name: "input_viability",
    failures: spec.input.length ? [] : ["input must offer at least one of mouse, touch or keyboard"],
    warnings: [],
  };
}

/** Budget keeps a generated entity list from becoming an unmaintainable zoo. */
export function checkEntityBudget(spec: GameSpec): GateResult {
  const failures: string[] = [];
  const empty = spec.entities.filter(entity => !entity.id.trim() || !entity.type.trim());
  if (empty.length) failures.push(`${empty.length} entit(ies) have an empty id or type`);
  if (spec.entities.length > 16) failures.push(`${spec.entities.length} entities exceeds the 16-entity budget`);
  return { name: "entity_budget", failures, warnings: [] };
}

/**
 * Order matters: cheap structural gates first, the gates that reason about
 * the interaction of several config values last. `runGates` runs them all
 * regardless, so this is about report readability, not short-circuiting.
 */
export const GATES: ReadonlyArray<(spec: GameSpec) => GateResult> = [
  checkGenreMechanics,
  checkPlayerEntity,
  checkInputViability,
  checkEntityBudget,
  checkGravityCoherence,
  checkGapViability,
  checkSpacingViability,
  checkSystemsCoverage,
];

/**
 * Run every gate and collect the full defect list.
 *
 * Deliberately does not stop at the first failure: the correction loop needs
 * all defects at once, because fixing one defect per iteration is exactly how
 * a bounded loop gets exhausted by a spec that has three.
 */
export function runGates(spec: GameSpec): GateReport {
  const reports = GATES.map(gate => gate(spec));
  return {
    ok: reports.every(report => report.failures.length === 0),
    reports,
    failures: reports.flatMap(report => report.failures),
    warnings: reports.flatMap(report => report.warnings),
  };
}
