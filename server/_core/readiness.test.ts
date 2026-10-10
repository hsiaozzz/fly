import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGenerationLimitsForTests, stopGenerationAdmission } from "../game/access";
import { resetValidationLimitsForTests, stopValidationAdmission } from "../game/validationAccess";

const mocked = vi.hoisted(() => ({ readiness: vi.fn() }));
vi.mock("../db", async importOriginal => ({ ...await importOriginal<typeof import("../db")>(), checkDatabaseReadiness: mocked.readiness }));
import { createApplication } from "./index";

let server: Server | undefined;
beforeEach(() => {
  mocked.readiness.mockReset(); resetGenerationLimitsForTests(); resetValidationLimitsForTests();
  vi.stubEnv("TRUST_PROXY_HOPS", "0");
});
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
  resetGenerationLimitsForTests(); resetValidationLimitsForTests(); vi.unstubAllEnvs();
});

describe("readiness during admission shutdown", () => {
  it.each(["generation", "validation"])("returns 503 if %s stops while its database probe is pending", async pool => {
    let started!: () => void, finishProbe!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    mocked.readiness.mockImplementation(() => new Promise<void>(resolve => { finishProbe = resolve; started(); }));
    server = createServer(createApplication());
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not return a port.");
    const response = fetch(`http://127.0.0.1:${address.port}/api/ready`);
    await entered;
    if (pool === "generation") stopGenerationAdmission();
    else stopValidationAdmission();
    finishProbe();
    const result = await response;
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ ready: false, database: true, activeGenerations: 0, activeValidations: 0 });
    expect(mocked.readiness).toHaveBeenCalledTimes(1);
  });
});
