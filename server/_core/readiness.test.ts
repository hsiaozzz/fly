import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGenerationLimitsForTests, stopGenerationAdmission } from "../game/access";
import { resetValidationLimitsForTests, stopValidationAdmission } from "../game/validationAccess";

const mocked = vi.hoisted(() => ({ readiness: vi.fn(), authenticate: vi.fn() }));
vi.mock("../db", async importOriginal => ({ ...await importOriginal<typeof import("../db")>(), checkDatabaseReadiness: mocked.readiness }));
vi.mock("./sdk", () => ({ sdk: { authenticateRequest: mocked.authenticate } }));
import { createApplication } from "./index";

let server: Server | undefined;
beforeEach(() => {
  mocked.readiness.mockReset(); mocked.authenticate.mockReset(); resetGenerationLimitsForTests(); resetValidationLimitsForTests();
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
  it("serves configuration discovery without invoking authentication or database probes", async () => {
    mocked.authenticate.mockRejectedValue(new Error("authentication unavailable"));
    mocked.readiness.mockRejectedValue(new Error("database unavailable"));
    vi.stubEnv("BUILT_IN_FORGE_API_KEY", "PRIVATE_CAPABILITY_SECRET");
    vi.stubEnv("BUILT_IN_FORGE_API_URL", "https://provider.test");
    server = createServer(createApplication());
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not return a port.");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/capabilities`, {
      headers: { Cookie: "app_session=expired-session" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const report = await response.json();
    expect(report.schemaVersion).toBe(1);
    expect(report.generation).toEqual({ configured: true, status: "configured", verification: "unverified" });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_CAPABILITY_SECRET");
    expect(JSON.stringify(report)).not.toContain("provider.test");
    expect(mocked.authenticate).not.toHaveBeenCalled();
    expect(mocked.readiness).not.toHaveBeenCalled();
  });
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
