import { describe, expect, it } from "vitest";
import type { FreeGenResult, GameArtifact } from "../shared/game/types";
import {
  acknowledgeSave,
  applyGeneratedResult,
  editWorkspaceFile,
  emptyWorkspace,
  isCurrentTask,
  parseDraftLibrary,
  serializeDraftLibrary,
  summarizeChanges,
  undoWorkspaceChange,
  type TaskContext,
} from "../client/src/lib/workspaceState";
import { GameEventDecoder, readGameStream } from "../client/src/lib/gameStream";

const artifact: GameArtifact = {
  title: "Runner",
  description: "Jump",
  controls: ["Space"],
  files: [
    { path: "index.html", content: "<canvas></canvas>", language: "html" },
  ],
};
const result: FreeGenResult = {
  artifact,
  build: { status: "passed", attempts: 1, repairApplied: false, logs: [] },
  trace: [],
  assistantMessage: "Created",
  validation: {
    stopReason: "passed",
    attempts: 1,
    failures: [],
    warnings: [],
    checks: [],
  },
};
const contextOf = (state: ReturnType<typeof emptyWorkspace>): TaskContext => ({
  documentId: state.documentId,
  projectId: state.projectId,
  baseVersionId: state.baseVersionId,
  revision: state.revision,
  runId: "run-1",
});

describe("canonical workspace documents", () => {
  it("edits the exported artifact and invalidates previous quality checks", () => {
    const generated = applyGeneratedResult(
      emptyWorkspace("document-a", 1),
      result
    );
    const edited = editWorkspaceFile(
      generated,
      "index.html",
      "<canvas>new</canvas>"
    );
    expect(edited.artifact?.files[0].content).toBe("<canvas>new</canvas>");
    expect(generated.artifact?.files[0].content).toBe("<canvas></canvas>");
    expect(edited.build).toBeNull();
    expect(edited.validation).toBeNull();
    expect(edited.dirty).toBe(true);
    expect(undoWorkspaceChange(edited).artifact).toEqual(generated.artifact);
  });

  it("rejects a generated result after project switches, edits or a newer saved base", () => {
    const original = applyGeneratedResult(
      emptyWorkspace("document-a", 1),
      result
    );
    const context = contextOf(original);
    expect(isCurrentTask(original, context)).toBe(true);
    expect(isCurrentTask({ ...original, projectId: 2 }, context)).toBe(false);
    expect(
      isCurrentTask({ ...original, documentId: "document-b" }, context)
    ).toBe(false);
    expect(
      isCurrentTask(
        editWorkspaceFile(original, "index.html", "changed"),
        context
      )
    ).toBe(false);
    expect(isCurrentTask({ ...original, baseVersionId: 4 }, context)).toBe(
      false
    );
  });

  it("a delayed save keeps later changes dirty and cannot mark another project saved", () => {
    const original = applyGeneratedResult(
      emptyWorkspace("document-a", 1),
      result
    );
    const context = contextOf(original);
    const edited = editWorkspaceFile(
      original,
      "index.html",
      "changed during save"
    );
    const ack = acknowledgeSave(edited, context, 9);
    expect(ack.dirty).toBe(true);
    expect(ack.baseVersionId).toBe(9);
    expect(ack.savedRevision).toBe(original.revision);
    const another = emptyWorkspace("document-b", 2);
    expect(acknowledgeSave(another, context, 9)).toBe(another);
  });

  it("restores separate local drafts after reload without retaining large undo copies", () => {
    const first = editWorkspaceFile(
      applyGeneratedResult(emptyWorkspace("a", 1), result),
      "index.html",
      "unsaved a"
    );
    const second = applyGeneratedResult(emptyWorkspace("b", 2), {
      ...result,
      artifact: { ...artifact, title: "B" },
    });
    const raw = serializeDraftLibrary({
      activeDocumentId: "b",
      documents: { a: first, b: second },
    });
    const parsed = parseDraftLibrary(raw);
    expect(parsed?.activeDocumentId).toBe("b");
    expect(parsed?.documents.a.projectId).toBe(1);
    expect(parsed?.documents.a.artifact?.files[0].content).toBe("unsaved a");
    expect(parsed?.documents.a.dirty).toBe(true);
    expect(parsed?.documents.b.artifact?.title).toBe("B");
    expect(parsed?.documents.a.undo).toEqual([]);
    expect(parseDraftLibrary('{"format":2,"documents":{}}')).toBeNull();
    expect(parseDraftLibrary("invalid")).toBeNull();
  });

  it("summarizes file additions, removals and changes for reversible edits", () => {
    const after = {
      ...artifact,
      files: [
        {
          path: "README.md",
          language: "markdown" as const,
          content: "README\ncontrols",
        },
      ],
    };
    expect(summarizeChanges(artifact, after)).toEqual([
      { path: "index.html", kind: "removed", beforeLines: 1, afterLines: 0 },
      { path: "README.md", kind: "added", beforeLines: 0, afterLines: 2 },
    ]);
  });
});

describe("game SSE decoding", () => {
  it("handles split UTF-8, CRLF, multiline JSON, comments and an EOF event", () => {
    const text =
      ': heartbeat\r\nevent: status\r\ndata: {"detail":\r\ndata: "你好"}\r\n\r\nevent: complete\ndata: {"ok":true}';
    const bytes = new TextEncoder().encode(text);
    const decoder = new GameEventDecoder();
    const events = [
      ...decoder.feed(bytes.slice(0, 71)),
      ...decoder.feed(bytes.slice(71)),
      ...decoder.feed(undefined, true),
    ];
    expect(events).toEqual([
      { event: "status", data: { detail: "你好" } },
      { event: "complete", data: { ok: true } },
    ]);
  });

  it("reports an interrupted stream instead of silently marking it completed", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response('event: status\ndata: {"detail":"working"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    try {
      await expect(
        readGameStream(
          { prompt: "runner" },
          new AbortController().signal,
          () => {}
        )
      ).rejects.toThrow("连接在生成完成前中断");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
