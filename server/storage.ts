import { randomUUID } from "node:crypto";
import { ENV } from "./_core/env";

export type StoredObject = { key: string; url: string };
export const STORAGE_TIMEOUT_MS = 15_000;

function config() {
  if (!ENV.forgeApiUrl || !ENV.forgeApiKey) throw new Error("Storage is not configured.");
  return { base: ENV.forgeApiUrl.replace(/\/+$/, ""), key: ENV.forgeApiKey };
}
export function normalizeStorageKey(key: string): string {
  if (!key || key.length > 720 || key.startsWith("/") || /[\\\u0000-\u001f]/.test(key)
    || key.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid storage key.");
  return key;
}
function objectUrl(key: string) { return `/manus-storage/${key.split("/").map(encodeURIComponent).join("/")}`; }
function validateSignedUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Storage returned an invalid URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Storage returned an insecure URL.");
  return url.toString();
}
function timeout(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(STORAGE_TIMEOUT_MS)]) : AbortSignal.timeout(STORAGE_TIMEOUT_MS); }
async function presign(operation: "put" | "get", key: string, signal?: AbortSignal): Promise<string> {
  const cfg = config();
  const url = new URL(`v1/storage/presign/${operation}`, `${cfg.base}/`);
  url.searchParams.set("path", normalizeStorageKey(key));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${cfg.key}` }, signal: timeout(signal) });
  if (!response.ok) throw new Error(`Storage signing failed (${response.status}).`);
  return validateSignedUrl((await response.json() as { url?: unknown }).url);
}

export async function storagePut(relKey: string, data: Buffer | Uint8Array | string, contentType = "application/octet-stream", options: { signal?: AbortSignal; onPrepared?: (key: string) => void | Promise<void> } = {}): Promise<StoredObject> {
  const normalized = normalizeStorageKey(relKey);
  const dot = normalized.lastIndexOf(".");
  const suffix = randomUUID().replace(/-/g, "");
  const key = dot > normalized.lastIndexOf("/") ? `${normalized.slice(0, dot)}_${suffix}${normalized.slice(dot)}` : `${normalized}_${suffix}`;
  normalizeStorageKey(key);
  // Register before uploading: even a response timeout can leave an object behind.
  await options.onPrepared?.(key);
  const url = await presign("put", key, options.signal);
  const body = new Blob([typeof data === "string" ? data : new Uint8Array(data)], { type: contentType });
  const response = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body, signal: timeout(options.signal) });
  if (!response.ok) throw new Error(`Storage upload failed (${response.status}).`);
  return { key, url: objectUrl(key) };
}
export async function storageGet(key: string): Promise<StoredObject> { return { key: normalizeStorageKey(key), url: objectUrl(key) }; }
export function storageGetSignedUrl(key: string, signal?: AbortSignal) { return presign("get", key, signal); }

export async function storageReadText(key: string, maxBytes = 400_000, cancellation?: AbortSignal): Promise<string> {
  const signal = timeout(cancellation);
  const response = await fetch(await storageGetSignedUrl(key, signal), { signal });
  if (!response.ok || !response.body) throw new Error("Stored file could not be read.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Stored file exceeds its size limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Forge's delete API is deployment-specific. Configure an authenticated adapter
 * accepting POST {path}; failed/unconfigured deletes remain in storage_cleanup. */
export async function storageDelete(key: string): Promise<void> {
  const endpoint = process.env.STORAGE_DELETE_URL;
  if (!endpoint) throw new Error("Storage deletion adapter is not configured.");
  const cfg = config();
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("Storage deletion adapter must use HTTPS.");
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" }, body: JSON.stringify({ path: normalizeStorageKey(key) }), signal: timeout() });
  if (!response.ok && response.status !== 404) throw new Error(`Storage deletion failed (${response.status}).`);
}
