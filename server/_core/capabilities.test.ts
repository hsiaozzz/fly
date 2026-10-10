import { afterEach, describe, expect, it, vi } from "vitest";
import { appCapabilitiesSchema, deriveAppCapabilities } from "../../shared/appCapabilities";
import type { TrpcContext } from "./context";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(actual.readFileSync) };
});

const configured = {
  BUILT_IN_FORGE_API_URL: "https://provider.arcane.test",
  BUILT_IN_FORGE_API_KEY: "private-provider-key",
  DATABASE_URL: "mysql://private-user:private-password@database.arcane.test:3306/projects",
  OAUTH_SERVER_URL: "https://identity.arcane.test",
  VITE_APP_ID: "arcane-project",
  JWT_SECRET: "independent-private-session-secret-123456789",
};

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("local configuration capability inspection", () => {
  it("distinguishes configuration from actual service or browser health", () => {
    const result = deriveAppCapabilities(configured, true);
    for (const capability of [result.generation, result.authentication, result.cloudProjects, result.database, result.objectStorage, result.browserQa])
      expect(capability).toEqual({ configured: true, status: "configured", verification: "unverified" });
    expect(appCapabilitiesSchema.safeParse(result).success).toBe(true);
    const output = JSON.stringify(result);
    for (const value of Object.values(configured)) expect(output).not.toContain(value);
    expect(output).not.toContain("BUILT_IN_FORGE");
  });

  it("requires both a provider address and a key for generation and object storage", () => {
    for (const missing of ["BUILT_IN_FORGE_API_URL", "BUILT_IN_FORGE_API_KEY"])
      expect(deriveAppCapabilities({ ...configured, [missing]: " " }).generation).toMatchObject({ configured: false, status: "missing" });
    const result = deriveAppCapabilities({ ...configured, BUILT_IN_FORGE_API_URL: "file:///private/provider" });
    expect(result.generation.status).toBe("invalid");
    expect(result.objectStorage.configured).toBe(false);
    expect(result.cloudProjects.configured).toBe(false);
  });

  it("recognizes the example configuration placeholders rather than enabling remote work", () => {
    const result = deriveAppCapabilities({
      BUILT_IN_FORGE_API_URL: "https://replace-with-your-provider.example",
      BUILT_IN_FORGE_API_KEY: "replace-with-your-server-key",
      DATABASE_URL: "mysql://replace-user:replace-password@127.0.0.1:3306/arcane",
      OAUTH_SERVER_URL: "https://replace-with-oauth-service.example",
      VITE_APP_ID: "replace-with-your-oauth-project-id",
      JWT_SECRET: "replace-with-random-secret-at-least-32-characters",
    });
    for (const capability of [result.generation, result.authentication, result.cloudProjects, result.database, result.objectStorage])
      expect(capability).toMatchObject({ configured: false, status: "placeholder" });
  });

  it.each(["not-a-url", "https://provider.example", "https://api.example.com", "javascript:alert(1)", "https://user:password@provider.arcane.test"])("rejects malformed or placeholder provider configuration %s", url => {
    expect(deriveAppCapabilities({ ...configured, BUILT_IN_FORGE_API_URL: url }).generation.configured).toBe(false);
  });

  it("separates database and storage dependencies for cloud saves", () => {
    const databaseMissing = deriveAppCapabilities({ ...configured, DATABASE_URL: "" });
    expect(databaseMissing.generation.configured).toBe(true);
    expect(databaseMissing.objectStorage.configured).toBe(true);
    expect(databaseMissing.database.status).toBe("missing");
    expect(databaseMissing.cloudProjects.configured).toBe(false);
    expect(databaseMissing.authentication.configured).toBe(false);
    for (const url of ["postgres://localhost/projects", "mysql://localhost", "mysql://user:%invalid@localhost/projects"])
      expect(deriveAppCapabilities({ ...configured, DATABASE_URL: url }).database.status).toBe("invalid");
  });

  it("requires safe signing and server login configuration without claiming frontend portal readiness", () => {
    for (const override of [{ JWT_SECRET: "short" }, { OAUTH_SERVER_URL: "ftp://identity.arcane.test" }, { VITE_APP_ID: "" }])
      expect(deriveAppCapabilities({ ...configured, ...override }).authentication.configured).toBe(false);
    expect(deriveAppCapabilities(configured).authentication.configured).toBe(true);
  });

  it("recognizes discovered browsers and keeps automatic discovery distinct from missing explicit paths", () => {
    expect(deriveAppCapabilities({}, true).browserQa).toMatchObject({ configured: true, status: "configured" });
    expect(deriveAppCapabilities({}).browserQa).toMatchObject({ configured: false, status: "automatic" });
    expect(deriveAppCapabilities({ ARCANE_BROWSER_EXECUTABLE: "/private/nonexistent-browser" }).browserQa.status).toBe("missing");
    expect(deriveAppCapabilities({ ARCANE_BROWSER_EXECUTABLE: "replace-with-browser" }, true).browserQa.status).toBe("placeholder");
  });

  it("rejects stale, inconsistent or secret-bearing API shapes", () => {
    const result = deriveAppCapabilities(configured, true);
    for (const value of [null, { generation: { configured: true } }, { ...result, key: "private-key" }, { ...result, generation: { ...result.generation, status: "missing" } }])
      expect(appCapabilitiesSchema.safeParse(value).success).toBe(false);
  });

  it("serves the anonymous capability API without network calls or reading configuration files", async () => {
    for (const [key, value] of Object.entries(configured)) vi.stubEnv(key, value);
    vi.stubEnv("ARCANE_BROWSER_EXECUTABLE", "");
    const fetch = vi.fn(() => { throw new Error("unexpected external request"); });
    vi.stubGlobal("fetch", fetch);
    const fs = await import("node:fs");
    const read = vi.mocked(fs.readFileSync);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const { runtimeCapabilities, systemRouter } = await import("./systemRouter");
    const caller = systemRouter.createCaller({ user: null } as TrpcContext);
    read.mockClear();
    const result = runtimeCapabilities();
    expect(result.generation.configured).toBe(true);
    expect(result.authentication.configured).toBe(true);
    expect(result.cloudProjects.configured).toBe(true);
    expect(result.browserQa.configured).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(await caller.capabilities()).toEqual(result);
    expect(read).not.toHaveBeenCalled();
  });
});
