import { randomUUID, createHash } from "node:crypto";
import JSZip from "jszip";
import { TRPCError } from "@trpc/server";
import type { BuildReport, GameArtifact, GameFile } from "../shared/game/types";
import { artifactDigest, validateArtifact } from "../shared/game/artifact";
import { bundleGameArtifact } from "../shared/game/bundle";
import type { StoredObject } from "./storage";

export type SaveVersionInput = { userId: number; projectId: number; artifact: GameArtifact; files?: GameFile[]; build: BuildReport; userPrompt?: string; assistantMessage?: string; requestId?: string; baseVersionId?: number | null; signal?: AbortSignal };
export type FileManifest = { path: string; language: GameFile["language"]; bytes: number; sha256: string }[];
export type VersionResult = { projectVersionId: number; version: number; manifest: FileManifest; artifactHash: string; state: "ready" };
export type PreparedVersion = { input: SaveVersionInput; artifact: GameArtifact; artifactHash: string; requestHash: string; manifest: FileManifest; archive: StoredObject; files: Array<StoredObject & { path: string; bytes: number; contentType: string }>; log: StoredObject };
export interface VersionBackend {
  authorize(input: SaveVersionInput): Promise<void>;
  replay(input: SaveVersionInput, requestHash: string): Promise<VersionResult | null>;
  upload(key: string, content: string | Buffer, type: string, onPrepared: (key: string) => void): Promise<StoredObject>;
  commit(prepared: PreparedVersion): Promise<{ result: VersionResult; replay: boolean }>;
  cleanup(keys: string[]): Promise<void>;
}
export const sha256 = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
export const contentTypeFor = (path: string) => path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".ts") ? "text/typescript" : path.endsWith(".json") ? "application/json" : path.endsWith(".md") ? "text/markdown" : path.endsWith(".html") ? "text/html" : "text/plain";

/** Upload outside DB transactions, then commit one immutable snapshot atomically.
 * Every attempted object is tracked for compensation, including timed-out PUTs. */
export async function persistVersion(input: SaveVersionInput, backend: VersionBackend): Promise<VersionResult> {
  input.signal?.throwIfAborted();
  const checked = validateArtifact(input.artifact);
  if (!checked.valid || !checked.artifact) throw new TRPCError({ code: "BAD_REQUEST", message: checked.errors.join(" ") });
  const artifact = checked.artifact;
  if (artifact.files.some(file => file.path === "game.artifact.json" || file.path === "build.log")) throw new TRPCError({ code: "BAD_REQUEST", message: "Artifact uses a reserved file path." });
  const artifactHash = await artifactDigest(artifact);
  const requestHash = sha256(JSON.stringify({ artifactHash, build: input.build, prompt: input.userPrompt, message: input.assistantMessage, baseVersionId: input.baseVersionId }));
  await backend.authorize(input);
  const replay = await backend.replay(input, requestHash);
  if (replay) return replay;
  const manifest = artifact.files.map(file => ({ path: file.path, language: file.language, bytes: Buffer.byteLength(file.content, "utf8"), sha256: sha256(file.content) }));
  const archive = new JSZip();
  artifact.files.forEach(file => archive.file(file.path, file.content));
  archive.file("game.artifact.json", JSON.stringify({ ...artifact, files: manifest }, null, 2));
  archive.file("__arcane__/artifact.json", JSON.stringify(artifact, null, 2));
  try {
    archive.file("__arcane__/play.html", bundleGameArtifact(artifact).html);
    archive.file("__arcane__/README.txt", "Open play.html to run the bundled game offline. Original source files are preserved at the archive root. This bundle is not a gameplay validation certificate.\n");
  } catch (error) {
    archive.file("__arcane__/README.txt", `This draft could not be bundled for offline play. Original sources are preserved. Resolve the diagnostic and validate again: ${error instanceof Error ? error.message : "Bundle failed."}\n`);
  }
  const buffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const prefix = `game-projects/${input.userId}/${input.projectId}/artifacts/${randomUUID()}`;
  const attempted: string[] = [];
  const upload = (path: string, content: string | Buffer, type: string) => backend.upload(`${prefix}/${path}`, content, type, key => attempted.push(key));
  try {
    const storedArchive = await upload("game-project.zip", buffer, "application/zip");
    const files: PreparedVersion["files"] = [];
    // Bounded memory and upstream pressure; artifacts contain at most 40 files.
    for (const file of artifact.files) {
      input.signal?.throwIfAborted();
      files.push({ ...await upload(file.path, file.content, contentTypeFor(file.path)), path: file.path, bytes: Buffer.byteLength(file.content, "utf8"), contentType: contentTypeFor(file.path) });
    }
    const log = await upload("build.log", input.build.logs.join("\n"), "text/plain");
    input.signal?.throwIfAborted();
    const committed = await backend.commit({ input, artifact, artifactHash, requestHash, manifest, archive: storedArchive, files, log });
    if (committed.replay) await backend.cleanup(attempted);
    return committed.result;
  } catch (error) {
    await backend.cleanup(attempted);
    throw error;
  }
}
