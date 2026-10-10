import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn(), createPool: vi.fn() }));
vi.mock("drizzle-orm/mysql2", async importOriginal => {
  const original = await importOriginal<typeof import("drizzle-orm/mysql2")>();
  return { ...original, drizzle: (config: unknown) => {
    mocked.createPool(config);
    // Supply the client directly: mocking a transitive mysql2 import can be
    // bypassed by externalized dependencies and must never open a test socket.
    const client = { promise: () => ({ query: mocked.query, end: mocked.close }) };
    return original.drizzle({ client: client as never });
  } };
});
import { checkDatabaseReadiness, closeDb } from "./db";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DATABASE_URL", "mysql://audit:placeholder@127.0.0.1:3306/never-connect");
  mocked.query.mockResolvedValue([[], []]); mocked.close.mockResolvedValue(undefined);
});
afterEach(async () => { await closeDb(); vi.unstubAllEnvs(); });

describe("database migration readiness", () => {
  it("checks new tables and columns with real Drizzle SQL and closes its pool", async () => {
    await checkDatabaseReadiness();
    const statements = mocked.query.mock.calls.map(([query]) => query.sql as string);
    expect(statements).toHaveLength(6);
    expect(statements[0]).toBe("SELECT 1");
    for (const field of ["`artifactHash`", "`requestId`", "`requestHash`", "`sourcePublicationId`", "`confirmedGameplay`", "`shareTokenHash`", "`revokedAt`", "`report`"])
      expect(statements.some(sql => sql.includes(field))).toBe(true);
    expect(statements.some(sql => sql.includes("from `storage_cleanup`"))).toBe(true);
    expect(mocked.createPool).toHaveBeenCalledWith({ connection: expect.objectContaining({ connectionLimit: 10, queueLimit: 50, connectTimeout: 5000 }) });
    await closeDb(); expect(mocked.close).toHaveBeenCalledTimes(1);
    await closeDb(); expect(mocked.close).toHaveBeenCalledTimes(1);
  });
  it.each(["sourcePublicationId", "confirmedGameplay", "requestHash", "storage_cleanup", "report"])("rejects a reachable database missing %s", async missing => {
    mocked.query.mockImplementation(async query => {
      if (query.sql.includes(`\`${missing}\``)) throw new Error(`Missing ${missing}`);
      return [[], []];
    });
    await expect(checkDatabaseReadiness()).rejects.toMatchObject({ cause: { message: `Missing ${missing}` } });
  });
});
