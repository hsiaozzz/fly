import { and, desc, eq, lt, isNull, sql, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { TRPCError } from "@trpc/server";
import { randomUUID, randomBytes } from "node:crypto";
import { builds, creditAccounts, creditLedger, generationCreditReservations, paymentNotifications, paymentOrders, gameFiles, messages, projects, projectVersions, publications, storageCleanup, type InsertUser, users } from "../drizzle/schema";
import type { BuildReport, GameArtifact, GameFile } from "../shared/game/types";
import { validateArtifact, artifactDigest } from "../shared/game/artifact";
import { storageReadText, storageDelete, storagePut } from "./storage";
import { ENV } from "./_core/env";
import { verifyValidationReceipt } from "./game/validationReceipt";
import { canReadPublication } from "./publicationAccess";
import { createRemixArtifact } from "./publicationRemix";
import { logError } from "./_core/logger";
import { persistVersion, sha256, type SaveVersionInput, type VersionResult, type PreparedVersion } from "./versionPersistence";

let _db: ReturnType<typeof drizzle> | null = null;
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) _db = drizzle({ connection: { uri: process.env.DATABASE_URL, connectTimeout: 5000, connectionLimit: 10, queueLimit: 50, enableKeepAlive: true } });
  return _db;
}
async function requireDb() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Database is unavailable." });
  return db;
}
export async function closeDb() { if (_db) { await _db.$client.promise().end(); _db = null; } }
export async function checkDatabaseReadiness() {
  const db = await requireDb();
  await db.execute(sql`SELECT 1`);
  // A reachable database without the required migrations is not ready.
  await Promise.all([
    db.select({ state: projectVersions.state, artifactHash: projectVersions.artifactHash, requestId: projectVersions.requestId, requestHash: projectVersions.requestHash }).from(projectVersions).limit(1),
    db.select({ sourcePublicationId: projects.sourcePublicationId }).from(projects).limit(1),
    db.select({ confirmedGameplay: publications.confirmedGameplay, shareTokenHash: publications.shareTokenHash, revokedAt: publications.revokedAt }).from(publications).limit(1),
    db.select({ report: builds.report }).from(builds).limit(1),
    db.select({ id: storageCleanup.id }).from(storageCleanup).limit(1),
    db.select({ id: paymentOrders.id, appId: paymentOrders.appId, status: paymentOrders.status }).from(paymentOrders).limit(1),
    db.select({ userId: creditAccounts.userId, environment: creditAccounts.environment, appId: creditAccounts.appId, available: creditAccounts.available, reserved: creditAccounts.reserved }).from(creditAccounts).limit(1),
    db.select({ eventKey: creditLedger.eventKey }).from(creditLedger).limit(1),
    db.select({ eventKey: paymentNotifications.eventKey }).from(paymentNotifications).limit(1),
    db.select({ taskId: generationCreditReservations.taskId, state: generationCreditReservations.state }).from(generationCreditReservations).limit(1),
  ]);
}
export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required.");
  const db = await requireDb();
  const values: InsertUser = { openId: user.openId, lastSignedIn: user.lastSignedIn ?? new Date(), role: user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user") };
  const updateSet: Record<string, unknown> = { lastSignedIn: values.lastSignedIn };
  if (user.role !== undefined) updateSet.role = user.role;
  (["name", "email", "loginMethod"] as const).forEach(field => { if (user[field] !== undefined) { values[field] = user[field] ?? null; updateSet[field] = user[field] ?? null; } });
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}
export async function getUserByOpenId(openId: string) {
  const db = await requireDb();
  return (await db.select().from(users).where(eq(users.openId, openId)).limit(1))[0];
}
function insertedId(result: unknown): number {
  const first = Array.isArray(result) ? result[0] : result;
  const id = first && typeof first === "object" && "insertId" in first ? Number((first as { insertId: unknown }).insertId) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Database insert did not return an identifier.");
  return id;
}
export async function listProjectsForUser(userId: number) {
  const db = await requireDb();
  return db.select().from(projects).where(eq(projects.userId, userId)).orderBy(desc(projects.updatedAt)).limit(100);
}
export async function createProjectForUser(userId: number, name: string, description: string, sourcePublicationId?: string) {
  const db = await requireDb();
  const id = insertedId(await db.insert(projects).values({ userId, name, description, sourcePublicationId }));
  return (await db.select().from(projects).where(eq(projects.id, id)).limit(1))[0];
}
export async function requireOwnedProject(userId: number, projectId: number) {
  const db = await requireDb();
  const project = (await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.userId, userId))).limit(1))[0];
  if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });
  return { db, project };
}
function revisionMatches(latestId: number | null, expected?: number | null) {
  if (expected !== undefined && latestId !== expected) throw new TRPCError({ code: "CONFLICT", message: "The project has a newer version. Reload before saving." });
}
export async function assertProjectRevision(userId: number, projectId: number, expected?: number | null) {
  const { db } = await requireOwnedProject(userId, projectId);
  const latest = (await db.select({ id: projectVersions.id }).from(projectVersions).where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.state, "ready"))).orderBy(desc(projectVersions.version)).limit(1))[0];
  revisionMatches(latest?.id ?? null, expected);
}
function versionResult(row: typeof projectVersions.$inferSelect): VersionResult {
  return { projectVersionId: row.id, version: row.version, manifest: row.manifest as VersionResult["manifest"], artifactHash: row.artifactHash ?? "", state: "ready" };
}
function replayMatches(row: typeof projectVersions.$inferSelect | undefined, requestHash: string) {
  if (!row) return null;
  if (row.requestHash !== requestHash) throw new TRPCError({ code: "CONFLICT", message: "This request identifier belongs to a different snapshot." });
  return versionResult(row);
}

export async function queueStorageCleanup(keys: string[]) {
  const unique = [...new Set(keys)];
  if (!unique.length) return;
  const db = await requireDb();
  await db.insert(storageCleanup).values(unique.map(storageKey => ({ storageKey }))).onDuplicateKeyUpdate({ set: { storageKey: sql`storageKey` } });
  // Keep compensation bounded on the request path; the durable job owns the rest.
  await Promise.all(unique.slice(0, 4).map(async key => {
    try { await storageDelete(key); await db.delete(storageCleanup).where(eq(storageCleanup.storageKey, key)); }
    catch (error) { logError("storage.cleanup.pending", error); }
  }));
}
export async function retryStorageCleanup(limit = 20) {
  const db = await requireDb();
  const rows = await db.select().from(storageCleanup).where(lt(storageCleanup.createdAt, new Date(Date.now() - 3_600_000))).orderBy(storageCleanup.id).limit(Math.min(Math.max(limit, 1), 100));
  let deleted = 0;
  for (const row of rows) {
    try { await storageDelete(row.storageKey); await db.delete(storageCleanup).where(eq(storageCleanup.id, row.id)); deleted++; }
    catch (error) { await db.update(storageCleanup).set({ attempts: row.attempts + 1 }).where(eq(storageCleanup.id, row.id)); logError("storage.cleanup.retry.failed", error); }
  }
  return { attempted: rows.length, deleted, pending: rows.length - deleted };
}

async function commitVersion(prepared: PreparedVersion) {
  const db = await requireDb();
  return db.transaction(async tx => {
    const { input } = prepared;
    // All writers lock the parent row before allocating a version number.
    const project = (await tx.select().from(projects).where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId))).limit(1).for("update"))[0];
    if (!project) throw new TRPCError({ code: "NOT_FOUND", message: "Project not found." });
    if (input.requestId) {
      const previous = (await tx.select().from(projectVersions).where(and(eq(projectVersions.projectId, input.projectId), eq(projectVersions.requestId, input.requestId))).limit(1))[0];
      const replay = replayMatches(previous, prepared.requestHash);
      if (replay) return { result: replay, replay: true };
    }
    const latest = (await tx.select().from(projectVersions).where(eq(projectVersions.projectId, input.projectId)).orderBy(desc(projectVersions.version)).limit(1))[0];
    revisionMatches(latest?.id ?? null, input.baseVersionId);
    input.signal?.throwIfAborted();
    const version = (latest?.version ?? 0) + 1;
    const { files: _files, ...metadata } = prepared.artifact;
    const id = insertedId(await tx.insert(projectVersions).values({ projectId: project.id, version, state: "ready", artifactHash: prepared.artifactHash, requestId: input.requestId ?? null, requestHash: prepared.requestHash, gameSpec: metadata, manifest: prepared.manifest, archiveStorageKey: prepared.archive.key, archiveStorageUrl: prepared.archive.url }));
    await tx.insert(gameFiles).values(prepared.files.map(file => ({ projectVersionId: id, path: file.path, storageKey: file.key, storageUrl: file.url, contentType: file.contentType, sizeBytes: file.bytes })));
    await tx.insert(builds).values({ projectVersionId: id, status: input.build.status, attempts: input.build.attempts, report: input.build, logStorageKey: prepared.log.key, logStorageUrl: prepared.log.url });
    const conversation = [input.userPrompt ? { role: "user" as const, content: input.userPrompt } : null, input.assistantMessage ? { role: "assistant" as const, content: input.assistantMessage } : null].filter((item): item is { role: "user" | "assistant"; content: string } => item !== null);
    if (conversation.length) await tx.insert(messages).values(conversation.map(item => ({ ...item, projectId: project.id, projectVersionId: id })));
    await tx.delete(storageCleanup).where(inArray(storageCleanup.storageKey, [prepared.archive.key, prepared.log.key, ...prepared.files.map(file => file.key)]));
    await tx.update(projects).set({ updatedAt: new Date(), name: prepared.artifact.title, description: prepared.artifact.description }).where(eq(projects.id, project.id));
    return { result: { projectVersionId: id, version, manifest: prepared.manifest, artifactHash: prepared.artifactHash, state: "ready" as const }, replay: false };
  });
}
export async function saveProjectVersion(input: SaveVersionInput) {
  return persistVersion(input, {
    authorize: async value => { await requireOwnedProject(value.userId, value.projectId); },
    replay: async (value, hash) => {
      if (!value.requestId) return null;
      const db = await requireDb();
      return replayMatches((await db.select().from(projectVersions).where(and(eq(projectVersions.projectId, value.projectId), eq(projectVersions.requestId, value.requestId))).limit(1))[0], hash);
    },
    upload: (key, data, type, onPrepared) => storagePut(key, data, type, { signal: input.signal, onPrepared: async storageKey => {
      onPrepared(storageKey);
      const db = await requireDb();
      await db.insert(storageCleanup).values({ storageKey });
    } }),
    commit: commitVersion,
    cleanup: async keys => { try { await queueStorageCleanup(keys); } catch (error) { logError("storage.cleanup.queue.unavailable", error); } },
  });
}

const versionMetadata = { id: projectVersions.id, version: projectVersions.version, state: projectVersions.state, artifactHash: projectVersions.artifactHash, createdAt: projectVersions.createdAt, title: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${projectVersions.gameSpec}, '$.title'))`, description: sql<string>`JSON_UNQUOTE(JSON_EXTRACT(${projectVersions.gameSpec}, '$.description'))` };
export async function listProjectVersions(userId: number, projectId: number, options: { cursor?: number; limit?: number } = {}) {
  const { db } = await requireOwnedProject(userId, projectId);
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const rows = await db.select(versionMetadata).from(projectVersions).where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.state, "ready"), options.cursor ? lt(projectVersions.version, options.cursor) : undefined)).orderBy(desc(projectVersions.version)).limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].version : null };
}
async function loadReadyVersion(version: typeof projectVersions.$inferSelect) {
  const db = await requireDb();
  const records = await db.select().from(gameFiles).where(eq(gameFiles.projectVersionId, version.id));
  const manifest = version.manifest as Array<{ path: string; language?: GameFile["language"]; sha256?: string }>;
  if (!Array.isArray(manifest) || manifest.length !== records.length || new Set(manifest.map(entry => entry.path)).size !== manifest.length || records.some(record => !manifest.some(entry => entry.path === record.path))) throw new Error("Stored snapshot manifest is incomplete.");
  const files: GameFile[] = new Array(records.length);
  const readAbort = new AbortController();
  const cancellation = AbortSignal.any([AbortSignal.timeout(45_000), readAbort.signal]);
  let nextRecord = 0;
  const reader = async () => {
    while (nextRecord < records.length) {
      cancellation.throwIfAborted();
      const index = nextRecord++; const record = records[index];
      const entry = manifest.find(item => item.path === record.path)!;
      const content = await storageReadText(record.storageKey, 400_000, cancellation);
      if (Buffer.byteLength(content) !== record.sizeBytes || (entry.sha256 && sha256(content) !== entry.sha256)) throw new Error("Stored snapshot integrity check failed.");
      const language = entry.language ?? (record.path.endsWith(".html") ? "html" : record.path.endsWith(".ts") ? "typescript" : record.path.endsWith(".json") ? "json" : record.path.endsWith(".md") ? "markdown" : "text");
      files[index] = { path: record.path, content, language };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, records.length) }, reader)).catch(error => { readAbort.abort(error); throw error; });
  const checked = validateArtifact({ ...(version.gameSpec as object), files });
  if (!checked.valid || !checked.artifact) throw new Error("Stored snapshot is invalid.");
  if (version.artifactHash && await artifactDigest(checked.artifact) !== version.artifactHash) throw new Error("Stored snapshot hash does not match.");
  const build = (await db.select({ report: builds.report }).from(builds).where(eq(builds.projectVersionId, version.id)).orderBy(desc(builds.id)).limit(1))[0];
  return { version: { id: version.id, version: version.version, artifactHash: version.artifactHash, state: version.state, createdAt: version.createdAt }, artifact: checked.artifact, files, build: build?.report as BuildReport | undefined };
}
export async function loadProjectVersion(userId: number, projectId: number, versionId: number) {
  const { db } = await requireOwnedProject(userId, projectId);
  const version = (await db.select().from(projectVersions).where(and(eq(projectVersions.id, versionId), eq(projectVersions.projectId, projectId), eq(projectVersions.state, "ready"))).limit(1))[0];
  if (!version) throw new TRPCError({ code: "NOT_FOUND", message: "Version not found." });
  return loadReadyVersion(version);
}
export async function latestProjectVersion(userId: number, projectId: number) {
  const { db } = await requireOwnedProject(userId, projectId);
  const version = (await db.select().from(projectVersions).where(and(eq(projectVersions.projectId, projectId), eq(projectVersions.state, "ready"))).orderBy(desc(projectVersions.version)).limit(1))[0];
  return version ? loadReadyVersion(version) : null;
}
export async function getProjectVersionArchive(userId: number, projectId: number, versionId: number) {
  const { db } = await requireOwnedProject(userId, projectId);
  const version = (await db.select().from(projectVersions).where(and(eq(projectVersions.id, versionId), eq(projectVersions.projectId, projectId), eq(projectVersions.state, "ready"))).limit(1))[0];
  if (!version?.archiveStorageKey) throw new TRPCError({ code: "NOT_FOUND", message: "Archive not found." });
  return { version: version.version, url: `/manus-storage/${version.archiveStorageKey.split("/").map(encodeURIComponent).join("/")}`, filename: `game-project-v${version.version}.zip` };
}

/** The object key must exist in an ownership-linked database record. */
export async function canReadStorageObject(userId: number, key: string) {
  const db = await requireDb();
  const owned = and(eq(projects.userId, userId), eq(projectVersions.state, "ready"));
  const file = await db.select({ id: gameFiles.id }).from(gameFiles).innerJoin(projectVersions, eq(gameFiles.projectVersionId, projectVersions.id)).innerJoin(projects, eq(projectVersions.projectId, projects.id)).where(and(owned, eq(gameFiles.storageKey, key))).limit(1);
  if (file.length) return true;
  const archive = await db.select({ id: projectVersions.id }).from(projectVersions).innerJoin(projects, eq(projectVersions.projectId, projects.id)).where(and(owned, eq(projectVersions.archiveStorageKey, key))).limit(1);
  if (archive.length) return true;
  const log = await db.select({ id: builds.id }).from(builds).innerJoin(projectVersions, eq(builds.projectVersionId, projectVersions.id)).innerJoin(projects, eq(projectVersions.projectId, projects.id)).where(and(owned, eq(builds.logStorageKey, key))).limit(1);
  return log.length > 0;
}

export async function publishVersion(userId: number, versionId: number, visibility: "private" | "unlisted" | "public", validationReceipt: string, confirmedGameplay: boolean) {
  if (!confirmedGameplay) throw new TRPCError({ code: "BAD_REQUEST", message: "Confirm that you have played and reviewed this version before publishing." });
  const db = await requireDb();
  const version = (await db.select({ version: projectVersions }).from(projectVersions).innerJoin(projects, eq(projectVersions.projectId, projects.id)).where(and(eq(projectVersions.id, versionId), eq(projects.userId, userId), eq(projectVersions.state, "ready"))).limit(1))[0]?.version;
  if (!version) throw new TRPCError({ code: "NOT_FOUND", message: "Version not found." });
  const loaded = await loadReadyVersion(version);
  if (!await verifyValidationReceipt(loaded.artifact, validationReceipt)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This exact snapshot needs successful server validation before publishing." });
  const id = randomUUID();
  const shareToken = visibility === "unlisted" ? randomBytes(32).toString("base64url") : undefined;
  await db.insert(publications).values({ id, projectVersionId: versionId, ownerId: userId, visibility, confirmedGameplay: 1, shareTokenHash: shareToken ? sha256(shareToken) : null });
  return { publicationId: id, visibility, shareToken, url: `/play/${id}${shareToken ? `?share=${shareToken}` : ""}` };
}
export async function revokePublication(userId: number, publicationId: string) {
  const db = await requireDb();
  const row = (await db.select().from(publications).where(and(eq(publications.id, publicationId), eq(publications.ownerId, userId))).limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Publication not found." });
  await db.update(publications).set({ revokedAt: new Date(), shareTokenHash: null }).where(eq(publications.id, publicationId));
  return { success: true };
}
export async function publishedVersion(publicationId: string, userId?: number, shareToken?: string) {
  const db = await requireDb();
  const row = (await db.select({ publication: publications, version: projectVersions }).from(publications).innerJoin(projectVersions, eq(publications.projectVersionId, projectVersions.id)).where(and(eq(publications.id, publicationId), isNull(publications.revokedAt), eq(projectVersions.state, "ready"))).limit(1))[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Publication not found." });
  const { publication, version } = row;
  if (!canReadPublication(publication, userId, shareToken)) throw new TRPCError({ code: "NOT_FOUND", message: "Publication not found." });
  const loaded = await loadReadyVersion(version);
  return { publication: { id: publication.id, visibility: publication.visibility, confirmedGameplay: Boolean(publication.confirmedGameplay), createdAt: publication.createdAt }, artifact: loaded.artifact, files: loaded.files, version: loaded.version };
}
export async function explorePublications(options: { cursor?: string; limit?: number } = {}) {
  const db = await requireDb();
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const rows = await db.select({ publicationId: publications.id, title: versionMetadata.title, description: versionMetadata.description, version: projectVersions.version, createdAt: publications.createdAt }).from(publications).innerJoin(projectVersions, eq(publications.projectVersionId, projectVersions.id)).where(and(eq(publications.visibility, "public"), isNull(publications.revokedAt), options.cursor ? lt(publications.id, options.cursor) : undefined)).orderBy(desc(publications.id)).limit(limit + 1);
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].publicationId : null };
}
export async function remixPublication(userId: number, publicationId: string, shareToken?: string) {
  const original = await publishedVersion(publicationId, userId, shareToken);
  const artifact = createRemixArtifact(original.artifact);
  const project = await createProjectForUser(userId, artifact.title, artifact.description, publicationId);
  const build: BuildReport = { status: "pending", attempts: 1, repairApplied: false, logs: [`Remixed from publication ${publicationId}; validation required before publishing.`] };
  try { const version = await saveProjectVersion({ userId, projectId: project.id, artifact, build, baseVersionId: null }); return { project, version, sourcePublicationId: publicationId }; }
  catch (error) { const db = await requireDb(); await db.delete(projects).where(eq(projects.id, project.id)); throw error; }
}
