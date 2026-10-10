import { z } from "zod";
import type {
  BuildReport,
  FreeGenResult,
  GameArtifact,
  TraceStep,
  ValidationSummary,
} from "@shared/game/types";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};
type ContentSnapshot = Pick<
  WorkspaceState,
  "artifact" | "build" | "validation" | "trace" | "intent"
>;
export type WorkspaceState = {
  documentId: string;
  projectId: number | null;
  baseVersionId: number | null;
  revision: number;
  savedRevision: number;
  dirty: boolean;
  artifact: GameArtifact | null;
  build: BuildReport | null;
  validation: ValidationSummary | null;
  trace: TraceStep[];
  intent: string;
  messages: ChatMessage[];
  undo: ContentSnapshot[];
  lastChange: "manual" | "generated" | null;
};
export type TaskContext = Pick<
  WorkspaceState,
  "documentId" | "projectId" | "baseVersionId" | "revision"
> & { runId: string };

export function emptyWorkspace(
  documentId: string,
  projectId: number | null = null
): WorkspaceState {
  return {
    documentId,
    projectId,
    baseVersionId: null,
    revision: 0,
    savedRevision: 0,
    dirty: false,
    artifact: null,
    build: null,
    validation: null,
    trace: [],
    intent: "",
    undo: [],
    lastChange: null,
    messages: [
      {
        id: `${documentId}-intro`,
        role: "assistant",
        content:
          "描述你想做的游戏。我会理解玩法、确认细节，再为你创作一个可试玩的游戏。草稿会自动保存在此浏览器。",
      },
    ],
  };
}

export function isCurrentTask(
  state: WorkspaceState,
  context: TaskContext
): boolean {
  return (
    state.documentId === context.documentId &&
    state.projectId === context.projectId &&
    state.baseVersionId === context.baseVersionId &&
    state.revision === context.revision
  );
}

function contentOf(state: WorkspaceState): ContentSnapshot {
  return {
    artifact: state.artifact,
    build: state.build,
    validation: state.validation,
    trace: state.trace,
    intent: state.intent,
  };
}

export function editWorkspaceFile(
  state: WorkspaceState,
  path: string,
  content: string
): WorkspaceState {
  if (
    !state.artifact ||
    !state.artifact.files.some(
      file => file.path === path && file.content !== content
    )
  )
    return state;
  return {
    ...state,
    artifact: {
      ...state.artifact,
      files: state.artifact.files.map(file =>
        file.path === path ? { ...file, content } : file
      ),
    },
    revision: state.revision + 1,
    dirty: true,
    build: null,
    validation: null,
    trace: [],
    undo:
      state.lastChange === "manual"
        ? state.undo
        : [...state.undo, contentOf(state)].slice(-3),
    lastChange: "manual",
  };
}

export function applyGeneratedResult(
  state: WorkspaceState,
  result: FreeGenResult
): WorkspaceState {
  return {
    ...state,
    artifact: result.artifact,
    build: result.build,
    validation: result.validation ?? null,
    trace: result.trace,
    intent: result.intent ?? "",
    revision: state.revision + 1,
    dirty: true,
    undo: state.artifact
      ? [...state.undo, contentOf(state)].slice(-3)
      : state.undo,
    lastChange: "generated",
  };
}

export function undoWorkspaceChange(state: WorkspaceState): WorkspaceState {
  const snapshot = state.undo.at(-1);
  if (!snapshot) return state;
  return {
    ...state,
    ...snapshot,
    revision: state.revision + 1,
    dirty: true,
    undo: state.undo.slice(0, -1),
    lastChange: null,
  };
}

export function acknowledgeSave(
  state: WorkspaceState,
  context: TaskContext,
  versionId: number
): WorkspaceState {
  if (
    state.documentId !== context.documentId ||
    state.projectId !== context.projectId
  )
    return state;
  return {
    ...state,
    baseVersionId: versionId,
    savedRevision: context.revision,
    dirty: state.revision !== context.revision,
  };
}

export function summarizeChanges(
  before: GameArtifact | null,
  after: GameArtifact | null
): Array<{
  path: string;
  kind: "added" | "removed" | "changed";
  beforeLines: number;
  afterLines: number;
}> {
  const previous = new Map(
    before?.files.map(file => [file.path, file.content]) ?? []
  );
  const current = new Map(
    after?.files.map(file => [file.path, file.content]) ?? []
  );
  return Array.from(
    new Set([...Array.from(previous.keys()), ...Array.from(current.keys())])
  ).flatMap(path => {
    const old = previous.get(path),
      next = current.get(path);
    if (old === next) return [];
    return [
      {
        path,
        kind:
          old === undefined
            ? ("added" as const)
            : next === undefined
              ? ("removed" as const)
              : ("changed" as const),
        beforeLines: old?.split("\n").length ?? 0,
        afterLines: next?.split("\n").length ?? 0,
      },
    ];
  });
}

const fileSchema = z.object({
  path: z.string().min(1).max(512),
  content: z.string().max(1_000_000),
  language: z.enum([
    "typescript",
    "json",
    "markdown",
    "html",
    "text",
    "javascript",
    "css",
  ]),
});
const artifactSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(2000),
    controls: z.array(z.string()).max(20),
    files: z.array(fileSchema).min(1).max(40),
  })
  .passthrough();
const gateSchema = z.object({
  name: z.string(),
  label: z.string(),
  status: z.enum(["pass", "warn", "fail"]),
  detail: z.string(),
  hint: z.string().optional(),
});
const buildSchema = z
  .object({
    status: z.enum(["passed", "failed", "pending"]),
    attempts: z.number().int().min(1),
    repairApplied: z.boolean(),
    logs: z.array(z.string()).max(1000),
    stopReason: z.enum(["passed", "exhausted", "repeating"]).optional(),
  })
  .passthrough();
const validationSchema = z.object({
  stopReason: z.string(),
  attempts: z.number(),
  failures: z.array(z.string()),
  warnings: z.array(z.string()),
  checks: z.array(gateSchema),
});
const traceSchema = z.object({
  agent: z.string(),
  status: z.enum([
    "running",
    "failed",
    "done",
    "repaired",
    "fallback",
    "clarify",
  ]),
  detail: z.string(),
  checks: z.array(gateSchema).optional(),
});
export const resultSchema = z.object({
  artifact: artifactSchema,
  build: buildSchema,
  trace: z.array(traceSchema),
  assistantMessage: z.string(),
  intent: z.string().optional(),
  validation: validationSchema.optional(),
});
const documentSchema = z.object({
  documentId: z.string().min(1),
  projectId: z.number().int().positive().nullable(),
  baseVersionId: z.number().int().positive().nullable(),
  revision: z.number().int().min(0),
  savedRevision: z.number().int().min(0),
  dirty: z.boolean(),
  artifact: artifactSchema.nullable(),
  build: buildSchema.nullable(),
  validation: validationSchema.nullable(),
  trace: z.array(traceSchema),
  intent: z.string(),
  messages: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(["user", "assistant", "system"]),
        content: z.string(),
      })
    )
    .max(200),
});
export type DraftLibrary = {
  activeDocumentId: string;
  documents: Record<string, WorkspaceState>;
};

export function serializeDraftLibrary(library: DraftLibrary): string {
  // Undo snapshots are useful during an editing session; do not triple local storage usage.
  return JSON.stringify({
    format: 2,
    activeDocumentId: library.activeDocumentId,
    documents: Object.fromEntries(
      Object.entries(library.documents).map(([key, state]) => [
        key,
        {
          ...state,
          messages: state.messages.slice(-200),
          undo: [],
          lastChange: null,
        },
      ])
    ),
  });
}

export function parseDraftLibrary(raw: string | null): DraftLibrary | null {
  if (!raw) return null;
  try {
    const value = z
      .object({
        format: z.literal(2),
        activeDocumentId: z.string(),
        documents: z.record(z.string(), documentSchema),
      })
      .parse(JSON.parse(raw));
    if (!value.documents[value.activeDocumentId]) return null;
    return {
      activeDocumentId: value.activeDocumentId,
      documents: Object.fromEntries(
        Object.entries(value.documents).map(([key, state]) => [
          key,
          { ...state, undo: [], lastChange: null } as WorkspaceState,
        ])
      ),
    };
  } catch {
    return null;
  }
}
