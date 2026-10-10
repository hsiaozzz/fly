import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { COOKIE_NAME } from "../shared/const";
import { validateArtifact, normalizeGameFiles } from "../shared/game/artifact";
import type { BuildReport } from "../shared/game/types";
import { createProjectForUser, getProjectVersionArchive, listProjectsForUser, listProjectVersions, loadProjectVersion, latestProjectVersion, saveProjectVersion, publishVersion, publishedVersion, revokePublication, explorePublications, remixPublication } from "./db";
import { freeGenerate, freePatch, type GenerationOptions } from "./game/freegen";
import type { FreeGenResult } from "../shared/game/types";
import { acquireBilledGenerationLease } from "./game/billedAccess";
import { acquireValidationLease } from "./game/validationAccess";
import { issueValidationReceipt, verifyValidationReceipt } from "./game/validationReceipt";
import { validateInBrowser } from "./game/browserQa";
import type { TrpcContext } from "./_core/context";
import { billingRouter } from "./payments/routes";

const artifactSchema = z.unknown().transform((input, ctx) => {
  const checked = validateArtifact(input);
  if (!checked.valid || !checked.artifact) { ctx.addIssue({ code: "custom", message: checked.errors.join(" ") }); return z.NEVER; }
  return checked.artifact;
});
const filesSchema = z.unknown().transform((input, ctx) => {
  try { return normalizeGameFiles(input); }
  catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid files." }); return z.NEVER; }
});
const buildSchema = z.object({ status: z.enum(["pending", "passed", "failed"]), attempts: z.number().int().min(1).max(3), repairApplied: z.boolean(), logs: z.array(z.string().max(2000)).max(80), stopReason: z.enum(["passed", "exhausted", "repeating"]).optional() });
const projectId = z.number().int().positive();
const versionId = z.number().int().positive();
const publicationId = z.string().uuid();
const pagination = { cursor: z.number().int().positive().optional(), limit: z.number().int().min(1).max(50).optional() };
async function withRequestAbort<T>(ctx: TrpcContext, run: (options: GenerationOptions) => Promise<T>) {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new DOMException("Request deadline exceeded.", "TimeoutError")), 240_000);
  const disconnected = () => { if (!ctx.res.writableEnded) abort.abort(new DOMException("Request cancelled.", "AbortError")); };
  ctx.res.on?.("close", disconnected);
  ctx.req.on?.("aborted", disconnected);
  try {
    // Authentication/context creation may have awaited while the client left.
    // Subscribe first, then check settled state so neither ordering loses abort.
    if (ctx.req.aborted || ctx.res.destroyed) abort.abort(new DOMException("Request cancelled.", "AbortError"));
    abort.signal.throwIfAborted();
    return await run({ signal: abort.signal });
  }
  finally { clearTimeout(deadline); ctx.res.removeListener?.("close", disconnected); ctx.req.removeListener?.("aborted", disconnected); }
}
async function withLease(ctx: TrpcContext, request: unknown, run: (options: GenerationOptions) => Promise<FreeGenResult>) {
  return withRequestAbort(ctx, async options => {
    const lease = await acquireBilledGenerationLease(ctx.req, ctx.user, request);
    let used = 0;
    try {
      options.signal?.throwIfAborted();
      const result = await run({ ...options, onUsage: tokens => { used += tokens; lease.recordUsage(used); } });
      options.signal?.throwIfAborted();
      if (result?.artifact && result.build?.status !== "failed") await lease.success(options.signal);
      return result;
    } finally { await lease.release(options.signal?.aborted ? "aborted" : "failed"); }
  });
}
async function withValidationLease<T>(ctx: TrpcContext, run: (options: GenerationOptions) => Promise<T>) {
  const lease = acquireValidationLease(ctx.user?.id ?? 0);
  try { return await withRequestAbort(ctx, run); }
  finally { lease.release(); }
}

export const appRouter = router({
  system: systemRouter,
  billing: billingRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => { ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 }); return { success: true } as const; }),
  }),
  game: router({
    generate: publicProcedure.input(z.object({ prompt: z.string().min(2).max(8000) })).mutation(({ ctx, input }) => withLease(ctx, { mode: "generate", ...input }, options => freeGenerate(input.prompt, undefined, options))),
    patch: publicProcedure.input(z.object({ prompt: z.string().min(2).max(8000), files: filesSchema })).mutation(({ ctx, input }) => withLease(ctx, { mode: "patch", ...input }, options => freePatch(input.files, input.prompt, options))),
    validateArtifact: protectedProcedure.input(z.object({ artifact: artifactSchema })).mutation(({ ctx, input }) => withValidationLease(ctx, async options => {
      const report = await validateInBrowser(input.artifact, { signal: options.signal });
      return { report, receipt: await issueValidationReceipt(input.artifact, report) ?? undefined };
    })),
    listProjects: protectedProcedure.query(({ ctx }) => listProjectsForUser(ctx.user.id)),
    createProject: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(500) })).mutation(({ ctx, input }) => createProjectForUser(ctx.user.id, input.name, input.description)),
    saveVersion: protectedProcedure.input(z.object({ projectId, artifact: artifactSchema, build: buildSchema, baseVersionId: versionId.nullable().optional(), requestId: z.string().uuid().optional(), validationReceipt: z.string().max(4096).optional(), userPrompt: z.string().max(8000).optional(), assistantMessage: z.string().max(8000).optional() })).mutation(({ ctx, input }) => withRequestAbort(ctx, async options => {
      // A client claiming "passed" does not establish trusted browser validation.
      const trusted = input.validationReceipt ? await verifyValidationReceipt(input.artifact, input.validationReceipt) : false;
      const build: BuildReport = { ...input.build, status: input.build.status === "failed" ? "failed" : trusted ? "passed" : "pending" };
      return saveProjectVersion({ ...input, userId: ctx.user.id, build, signal: options.signal });
    })),
    versions: protectedProcedure.input(z.object({ projectId, ...pagination })).query(({ ctx, input }) => listProjectVersions(ctx.user.id, input.projectId, input)),
    latestVersion: protectedProcedure.input(z.object({ projectId })).query(({ ctx, input }) => latestProjectVersion(ctx.user.id, input.projectId)),
    loadVersion: protectedProcedure.input(z.object({ projectId, versionId })).mutation(({ ctx, input }) => loadProjectVersion(ctx.user.id, input.projectId, input.versionId)),
    downloadVersion: protectedProcedure.input(z.object({ projectId, versionId })).mutation(({ ctx, input }) => getProjectVersionArchive(ctx.user.id, input.projectId, input.versionId)),
    publishVersion: protectedProcedure.input(z.object({ projectVersionId: versionId, visibility: z.enum(["private", "unlisted", "public"]), validationReceipt: z.string().min(1).max(4096), confirmedGameplay: z.boolean() })).mutation(({ ctx, input }) => publishVersion(ctx.user.id, input.projectVersionId, input.visibility, input.validationReceipt, input.confirmedGameplay)),
    revokePublication: protectedProcedure.input(z.object({ publicationId })).mutation(({ ctx, input }) => revokePublication(ctx.user.id, input.publicationId)),
    publishedVersion: publicProcedure.input(z.object({ publicationId, shareToken: z.string().max(128).optional() })).query(({ ctx, input }) => publishedVersion(input.publicationId, ctx.user?.id, input.shareToken)),
    explore: publicProcedure.input(z.object({ cursor: publicationId.optional(), limit: z.number().int().min(1).max(50).optional() }).optional()).query(({ input }) => explorePublications(input)),
    remix: protectedProcedure.input(z.object({ publicationId, shareToken: z.string().max(128).optional() })).mutation(({ ctx, input }) => remixPublication(ctx.user.id, input.publicationId, input.shareToken)),
  }),
});
export type AppRouter = typeof appRouter;
