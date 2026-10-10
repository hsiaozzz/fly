import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionCookieOptions } from "./cookies";
import { safeError } from "./logger";
import type { Request } from "express";

describe("session scope and cookie transport", () => {
  beforeEach(() => { vi.resetModules(); vi.stubEnv("JWT_SECRET", "test-only-long-random-value-1234567890"); vi.stubEnv("VITE_APP_ID", "test-app"); });
  it("accepts nameless users and rejects other app IDs and expired tokens", async () => {
    const { sdk } = await import("./sdk");
    expect(await sdk.verifySession(await sdk.createSessionToken("test-user"))).toMatchObject({ openId: "test-user", name: "", appId: "test-app" });
    expect(await sdk.verifySession(await sdk.signSession({ openId: "test-user", name: "User", appId: "other-app" }))).toBeNull();
    expect(await sdk.verifySession(await sdk.createSessionToken("test-user", { expiresInMs: -1000 }))).toBeNull();
    expect(await sdk.verifySession("invalid" )).toBeNull();
  });
  it("uses local Lax cookies and ignores untrusted forwarded headers", () => {
    expect(getSessionCookieOptions({ protocol: "http", headers: { "x-forwarded-proto": "https" } } as unknown as Request)).toMatchObject({ sameSite: "lax", secure: false });
    expect(getSessionCookieOptions({ protocol: "https" } as Request)).toMatchObject({ sameSite: "none", secure: true, httpOnly: true });
  });
  it("keeps SDK secrets and signed URL bodies out of diagnostic logs", () => {
    const error = Object.assign(new Error("Bearer secret; https://s3/?token=secret"), { response: { status: 401, data: "secret" } });
    expect(safeError(error)).toEqual({ name: "Error", status: 401 });
    expect(JSON.stringify(safeError(error))).not.toContain("secret");
  });
});
