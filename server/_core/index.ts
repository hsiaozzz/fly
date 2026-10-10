import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import { createServer } from "node:http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./static";
import { registerGameStreamRoute } from "../game/streamRoute";
import { checkDatabaseReadiness, closeDb } from "../db";
import { logError } from "./logger";
import { generationCapacity, stopGenerationAdmission } from "../game/access";
import { validationCapacity, stopValidationAdmission } from "../game/validationAccess";
import { runtimeCapabilities } from "./systemRouter";
import { registerPaymentRoutes } from "../payments/routes";

export function validateProductionConfig() {
  const required = ["JWT_SECRET", "VITE_APP_ID", "DATABASE_URL", "OAUTH_SERVER_URL", "BUILT_IN_FORGE_API_URL", "BUILT_IN_FORGE_API_KEY"];
  const missing = required.filter(name => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  if (process.env.JWT_SECRET!.length < 32) throw new Error("JWT_SECRET must contain at least 32 characters.");
}
export function configuredPort() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535.");
  return port;
}
export function createApplication() {
  const app = express();
  app.disable("x-powered-by");
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(hops) || hops < 0 || hops > 3) throw new Error("TRUST_PROXY_HOPS must be between 0 and 3.");
  app.set("trust proxy", hops);
  registerPaymentRoutes(app);
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ limit: "4mb", extended: false }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  // Configuration discovery stays available even when authentication or the
  // database is unavailable. It never probes external services or returns keys.
  app.get("/api/capabilities", (_req, res) => {
    res.set("Cache-Control", "no-store").json(runtimeCapabilities());
  });
  app.get("/api/ready", async (_req, res) => {
    try {
      await checkDatabaseReadiness();
      // Shutdown can begin while the database checks are still pending.
      const capacity = generationCapacity();
      const browserCapacity = validationCapacity();
      const draining = capacity.draining || browserCapacity.draining;
      res.status(draining ? 503 : 200).json({ ready: !draining, database: true, activeGenerations: capacity.active, activeValidations: browserCapacity.active });
    }
    catch (error) { logError("readiness.database.failed", error); res.status(503).json({ ready: false, database: false }); }
  });
  registerStorageProxy(app);
  registerOAuthRoutes(app);
  registerGameStreamRoute(app);
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext, onError: ({ error }) => logError("rpc.failed", error) }));
  return app;
}
export async function startServer() {
  const production = process.env.NODE_ENV === "production";
  if (production) { validateProductionConfig(); await checkDatabaseReadiness(); }
  const app = createApplication();
  const server = createServer(app);
  if (process.env.NODE_ENV === "development") {
    // Kept in a separate build chunk: production does not load Vite/plugins.
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else serveStatic(app);
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    logError("http.failed", error);
    if (res.headersSent) { res.end(); return; }
    const status = (error as { status?: number }).status;
    res.status(status === 413 ? 413 : status === 400 ? 400 : 500).json({ error: status === 413 ? "Request exceeds the size limit." : "Request could not be completed." });
  };
  app.use(errorHandler);
  const port = configuredPort();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, () => { server.removeListener("error", reject); resolve(); }); });
  console.log(JSON.stringify({ event: "server.started", port }));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true; stopGenerationAdmission(); stopValidationAdmission();
    const force = setTimeout(() => server.closeAllConnections(), 10_000); force.unref();
    server.close(() => { clearTimeout(force); closeDb().catch(error => { logError("database.close.failed", error); process.exitCode = 1; }); });
  };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
  return { app, server, shutdown };
}
if (process.env.NODE_ENV !== "test") startServer().catch(async error => {
  logError("server.start.failed", error);
  await closeDb().catch(closeError => logError("database.close.failed", closeError));
  process.exitCode = 1;
});
