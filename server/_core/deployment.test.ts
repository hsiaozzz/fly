import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredPort, validateProductionConfig } from "./index";
afterEach(() => vi.unstubAllEnvs());
describe("production startup invariants", () => {
  it("requires configured production dependencies and a long signing secret", () => {
    for (const name of ["JWT_SECRET", "VITE_APP_ID", "DATABASE_URL", "OAUTH_SERVER_URL", "BUILT_IN_FORGE_API_URL", "BUILT_IN_FORGE_API_KEY"]) vi.stubEnv(name, "");
    expect(validateProductionConfig).toThrow("Missing production configuration");
    for (const name of ["VITE_APP_ID", "DATABASE_URL", "OAUTH_SERVER_URL", "BUILT_IN_FORGE_API_URL", "BUILT_IN_FORGE_API_KEY"]) vi.stubEnv(name, "test-only-placeholder");
    vi.stubEnv("JWT_SECRET", "short"); expect(validateProductionConfig).toThrow("32 characters");
    vi.stubEnv("JWT_SECRET", "test-only-long-random-value-1234567890"); expect(validateProductionConfig).not.toThrow();
  });
  it("rejects invalid fixed ports instead of silently changing endpoints", () => {
    for (const port of ["NaN", "0", "65536", "3.2"]) { vi.stubEnv("PORT", port); expect(configuredPort).toThrow(); }
    vi.stubEnv("PORT", "3000"); expect(configuredPort()).toBe(3000);
  });
});
