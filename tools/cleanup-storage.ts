import "dotenv/config";
import { closeDb, retryStorageCleanup } from "../server/db";
import { logError } from "../server/_core/logger";

try { console.log(JSON.stringify(await retryStorageCleanup(20))); }
catch (error) { logError("storage.cleanup.job.failed", error); process.exitCode = 1; }
finally { await closeDb(); }
