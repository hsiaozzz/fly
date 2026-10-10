import type { Express } from "express";
import { canReadStorageObject } from "../db";
import { normalizeStorageKey, storageGetSignedUrl } from "../storage";
import { createContext } from "./context";
import { logError } from "./logger";

export function publicStorageKeys(): Set<string> {
  const keys = (process.env.PUBLIC_STORAGE_KEYS ?? "").split(",").map(key => key.trim()).filter(Boolean);
  const logo = process.env.VITE_APP_LOGO ?? "";
  if (logo.startsWith("/manus-storage/")) keys.push(decodeURIComponent(logo.slice("/manus-storage/".length)));
  return new Set(keys.filter(key => { try { normalizeStorageKey(key); return true; } catch { return false; } }));
}
export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    try {
      const key = normalizeStorageKey((req.params as Record<string, string>)[0] ?? "");
      if (!publicStorageKeys().has(key)) {
        const { user } = await createContext({ req, res, info: {} as never });
        if (!user || !await canReadStorageObject(user.id, key)) { res.status(404).send("Object not found."); return; }
      }
      const url = await storageGetSignedUrl(key);
      res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      res.redirect(307, url);
    } catch (error) {
      logError("storage.read.failed", error);
      res.status(503).send("Object is temporarily unavailable.");
    }
  });
}
