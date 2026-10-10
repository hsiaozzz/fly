import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { clarifyRequest, createGenerationJobOptions, freeGenerate, freePatch } from "./freegen";
import { acquireBilledGenerationLease } from "./billedAccess";
import { sdk } from "../_core/sdk";
import { HttpError } from "../../shared/_core/errors";
import { validateArtifact, normalizeGameFiles } from "../../shared/game/artifact";
import { assertProjectRevision } from "../db";
import { TRPCError } from "@trpc/server";
import { logError } from "../_core/logger";

const streamInput = z.object({
  prompt: z.string().trim().min(1).max(8000),
  answers: z.record(z.string().max(80), z.string().max(2000)).optional().refine(value => !value || Object.keys(value).length <= 8, "Too many answers"),
  mode: z.enum(["generate", "patch"]).default("generate"),
  existing: z.unknown().optional(),
  artifact: z.unknown().optional(),
  projectId: z.number().int().positive().nullish(),
  baseVersionId: z.number().int().positive().nullish(),
  runId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),
});
function emit(res: Response, event: string, data: unknown): void {
  if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
export function registerGameStreamRoute(app: Express): void {
  app.post("/api/game/stream", async (req: Request, res: Response) => {
    const input = streamInput.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: "请求格式或大小不合法。" }); return; }
    const { prompt, answers, mode, projectId, baseVersionId } = input.data;
    const runId = input.data.runId ?? randomUUID();
    const abort = new AbortController();
    let lease: Awaited<ReturnType<typeof acquireBilledGenerationLease>> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const deadline = setTimeout(() => abort.abort(new DOMException("生成任务超时，请缩小请求后重试。", "TimeoutError")), 240_000);
    const disconnect = () => { if (!res.writableEnded) abort.abort(new DOMException("任务已取消。", "AbortError")); };
    res.on("close", disconnect);
    try {
      let user = null;
      try { user = await sdk.authenticateRequest(req); }
      catch (error) { if (!(error instanceof HttpError && [401, 403].includes(error.statusCode))) throw error; }
      if (projectId != null) {
        if (!user) { res.status(401).json({ error: "请登录后操作项目。" }); return; }
        await assertProjectRevision(user.id, projectId, baseVersionId);
      }
      const artifactCheck = input.data.artifact === undefined ? null : validateArtifact(input.data.artifact);
      if (artifactCheck && !artifactCheck.artifact) { res.status(400).json({ error: artifactCheck.errors.join("\n") }); return; }
      let existing;
      try { existing = mode === "patch" ? artifactCheck?.artifact?.files ?? normalizeGameFiles(input.data.existing) : undefined; }
      catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "修改需要有效的源码快照。" }); return; }
      abort.signal.throwIfAborted();
      lease = await acquireBilledGenerationLease(req, user, { mode, prompt, answers, artifact: artifactCheck?.artifact, existing });
      abort.signal.throwIfAborted();
      res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.flushHeaders();
      heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(": heartbeat\n\n"); }, 15_000);
      let tokens = 0;
      const options = createGenerationJobOptions({
        signal: abort.signal,
        onStage: (step: unknown) => { if (!abort.signal.aborted) emit(res, "status", { ...(step as object), runId }); },
        onUsage: (usage: number) => { tokens += usage; lease?.recordUsage(tokens); },
        existingArtifact: artifactCheck?.artifact ?? undefined,
      });
      if (mode === "generate") {
        const { decision } = await clarifyRequest(prompt, answers, options);
        abort.signal.throwIfAborted();
        if (decision.needClarification) { emit(res, "clarify", { intent: decision.intent, questions: decision.questions, runId }); return; }
        const result = await freeGenerate(prompt, answers, { ...options, decision });
        abort.signal.throwIfAborted();
        if (result.artifact && result.build?.status !== "failed") await lease.success(abort.signal);
        emit(res, "complete", { ...result, runId, projectId, baseVersionId });
      } else {
        const result = await freePatch(existing!, prompt, options);
        abort.signal.throwIfAborted();
        if (result.artifact && result.build?.status !== "failed") await lease.success(abort.signal);
        emit(res, "complete", { ...result, runId, projectId, baseVersionId });
      }
    } catch (error) {
      if (res.destroyed) return;
      if (!abort.signal.aborted) logError("generation.failed", error);
      const transportFailure = Boolean((error as { isAxiosError?: boolean })?.isAxiosError) || error instanceof TypeError || typeof (error as { sqlState?: unknown })?.sqlState === "string";
      const message = error instanceof TRPCError || (res.headersSent && error instanceof Error && !transportFailure)
        ? error.message.slice(0, 2000) : "任务服务暂时不可用，请重试。";
      if (res.headersSent) emit(res, "error", { message, runId, code: abort.signal.aborted ? "CANCELLED" : "FAILED" });
      else { const code = (error as { code?: string })?.code; res.status(code === "TOO_MANY_REQUESTS" ? 429 : code === "UNAUTHORIZED" ? 401 : code === "CONFLICT" ? 409 : code === "NOT_FOUND" ? 404 : 503).json({ error: message }); }
    } finally {
      clearTimeout(deadline);
      if (heartbeat) clearInterval(heartbeat);
      res.removeListener("close", disconnect);
      try { await lease?.release(abort.signal.aborted ? "aborted" : "failed"); }
      catch (error) { logError("generation.credit.release.failed", error); }
      if (!res.destroyed && !res.writableEnded) res.end();
    }
  });
}
