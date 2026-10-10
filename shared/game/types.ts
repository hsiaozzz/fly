/**
 * Game pipeline types.
 * This file was missing from the source tree (type-only imports hid it at
 * runtime). Rebuilt from usage sites, extended with free-form generation types.
 */

export type SupportedGameType = "flappy" | "shooter" | "runner" | "journey";

/** 地貌带：驱动速度、体力消耗、天气、配色与威胁。 */
export type RegionDef = {
  id: string;
  name: string;
  /** 速度系数，0.4–1.4 */
  speed: number;
  /** 体力消耗系数，0.6–2.0 */
  drain: number;
  /** 天气 id 列表，如 ["sandstorm","heat"] */
  weather: string[];
  /** [天空顶, 天空底, 地面] 十六进制色 */
  palette: [string, string, string];
  hazards: string[];
};

/** 航线节点：环线上的落脚点。 */
export type NodeDef = {
  id: string;
  region: string;
  name: string;
  kind: "village" | "stable" | "camp" | "ruin" | "gate";
  /** 到下一节点的里程 */
  distance: number;
  /** 可选路线（平道/捷径/险路） */
  routes?: { id: string; label: string; risk: number; time: number }[];
};

export type EventChoiceDef = {
  id: string;
  label: string;
  /** 可选前置条件表达式，如 "renown>=3" */
  requires?: string;
  /** 数值后果，如 { coin: -20, renown: -1 } */
  effects: Record<string, number>;
  log?: string;
};

export type EventDef = {
  id: string;
  region?: string;
  title: string;
  text: string;
  weight: number;
  choices: EventChoiceDef[];
};

/**
 * 委托：绑定在某个落脚点上的小任务。
 * 结构与事件一致（choices 复用同一套 effects 解释器），
 * 差别只在「由节点触发」且「每个委托一生只能做一次」。
 */
export type QuestDef = {
  id: string;
  /** 绑定节点 id */
  node: string;
  title: string;
  /** 发布者，用于渲染「谁在找人帮忙」 */
  giver: string;
  text: string;
  /** 可选前置条件，如 "renown>=2"；不满足时委托板上会置灰并提示 */
  requires?: string;
  choices: EventChoiceDef[];
};

/**
 * 隐藏奇遇：满足条件才会现身的稀有事件（一局一次）。
 * 触发条件是「状态门槛」而非随机——玩家靠玩法行为（羁绊、见闻、清白、速写数）解锁，
 * 未触发时只在图鉴里留下一句传闻当线索。
 */
export type SecretDef = {
  id: string;
  /** 限定风貌带；省略表示全图判定 */
  region?: string;
  title: string;
  text: string;
  /** 图鉴里对未发现奇遇显示的传闻线索 */
  hint?: string;
  /** 触发条件表达式，如 "bond>=78" */
  requires?: string;
  choices: EventChoiceDef[];
};

export type EndingDef = {
  id: string;
  name: string;
  /** 判定条件表达式，如 "insight>=80 && bond>=90" */
  condition: string;
  text: string;
};

/**
 * 开放世界 / 旅行叙事类游戏的数据表。编译器把它整体注入运行时，
 * 引擎只解释数据，不写死内容——新增地貌或事件无需改引擎。
 */
export type GameData = {
  regions: RegionDef[];
  nodes: NodeDef[];
  events: EventDef[];
  /** 节点委托板内容，按 node id 归属 */
  quests?: QuestDef[];
  /** 隐藏奇遇，按条件触发 */
  secrets?: SecretDef[];
  endings: EndingDef[];
  /** 起始资源 */
  start?: Record<string, number>;
};

export type GameSpec = {
  schemaVersion: "1.0";
  game: {
    title: string;
    genre: SupportedGameType;
    orientation: "landscape" | "portrait";
    description: string;
  };
  player: { type: string; movement: string; color: string };
  mechanics: string[];
  entities: { id: string; type: string }[];
  systems: string[];
  input: ("mouse" | "touch" | "keyboard")[];
  config: {
    playerSpeed: number;
    gravity: number;
    obstacleGap: number;
    obstacleInterval: number;
    startingHealth: number;
  };
  /** 仅 journey 类游戏使用；其它类型可省略。 */
  data?: GameData;
};

export type GameFileLanguage = "typescript" | "javascript" | "css" | "json" | "markdown" | "html" | "text";

export type GameFile = {
  path: string;
  content: string;
  language: GameFileLanguage;
};

export type BuildReport = {
  status: "pending" | "passed" | "failed";
  attempts: number;
  repairApplied: boolean;
  logs: string[];
  /**
   * Why the repair loop stopped. `repeating` means the repair step could not
   * address the defect at all, so further iterations were skipped rather than
   * spent reproducing the same diagnostic.
   */
  stopReason?: "passed" | "exhausted" | "repeating";
};

export type PatchOperation = {
  op: "create" | "delete" | "rename" | "modify";
  file: string;
  to?: string;
  content?: string;
  language?: GameFileLanguage;
  target?: string;
  value?: string | number;
};

export type GamePatch = {
  type: "game_patch";
  rationale: string;
  operations: PatchOperation[];
};

/**
 * Free-form generation: the LLM produces a complete game artifact (a file
 * tree) instead of filling one of three maintained templates. `index.html`
 * must be present and be self-contained enough to run in a sandboxed iframe.
 */
export type GameArtifact = {
  title: string;
  description: string;
  /** Short human-readable control instructions, e.g. ["←/→ 移动", "Space 跳跃"]. */
  controls: string[];
  files: GameFile[];
};

export type ClarifyQuestion = {
  id: string;
  question: string;
  hint?: string;
};

export type ClarifyDecision = {
  /** One-sentence interpretation of what the user asked for. */
  intent: string;
  needClarification: boolean;
  questions: ClarifyQuestion[];
};

export type TraceStep = {
  agent: string;
  status: "running" | "failed" | "done" | "repaired" | "fallback" | "clarify";
  detail: string;
  /**
   * Gate results attached to this step. The UI renders them so a rejected
   * generation explains itself instead of just reporting "failed".
   */
  checks?: GateCheck[];
};

/** One deterministic gate outcome, ready to render. */
export type GateCheck = {
  name: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  /** What to change. Present when the check is not passing. */
  hint?: string;
};

/**
 * Result of the semantic gate pass over a generated artifact.
 *
 * `stopReason` is the same vocabulary as the spec corrector: a caller needs to
 * tell "fixed it" apart from "re-prompting cannot fix this", because the
 * second one should not be retried.
 */
export type ValidationSummary = {
  stopReason: string;
  attempts: number;
  failures: string[];
  warnings: string[];
  checks: GateCheck[];
};

export type FreeGenResult = {
  artifact: GameArtifact;
  trace: TraceStep[];
  build: BuildReport;
  assistantMessage: string;
  /** One-sentence interpretation of the request, surfaced in the UI as "已理解". */
  intent?: string;
  /** Static playability gate results, rendered in the UI's QA panel. */
  validation?: ValidationSummary;
  design?: import("./design").GameDesign;
  validationReceipt?: string;
};

export type ClarifyResult = {
  decision: ClarifyDecision;
  trace: TraceStep[];
};
