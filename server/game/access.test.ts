import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireGenerationLease, generationCapacity, resetGenerationLimitsForTests, stopGenerationAdmission } from "./access";
import type { Request } from "express";
const req = (ip = "127.0.0.1") => ({ ip, headers: {} } as Request);
beforeEach(() => { resetGenerationLimitsForTests(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T01:00:00Z")); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("shared generation safety caps", () => {
  it("shares anonymous allowance and keeps release idempotent", () => {
    const lease = acquireGenerationLease(req());
    expect(() => acquireGenerationLease(req())).toThrow("already running");
    lease.release(); lease.release(); expect(generationCapacity().active).toBe(0);
    for (let i = 0; i < 2; i++) acquireGenerationLease(req()).release();
    expect(() => acquireGenerationLease(req())).toThrow("Anonymous allowance");
  });
  it("reserves a global budget before starting and gates all identities", () => {
    vi.stubEnv("GENERATION_GLOBAL_DAILY_TOKENS", "64000");
    acquireGenerationLease(req("ip-one")).release();
    expect(() => acquireGenerationLease(req("ip-two"), { id: 2 })).toThrow("budget");
  });
  it.each(["0", "", " ", "Infinity", "NaN", "-1", "0.5", "9007199254740992"])("uses a finite positive reservation when configured with %j", invalid => {
    vi.stubEnv("GENERATION_TOKEN_RESERVE", invalid);
    vi.stubEnv("GENERATION_GLOBAL_DAILY_TOKENS", "64000");
    acquireGenerationLease(req("ip-one")).release();
    expect(() => acquireGenerationLease(req("ip-two"))).toThrow("budget");
  });
  it("respects a configured positive reservation and never refunds failures or smaller usage", () => {
    vi.stubEnv("GENERATION_TOKEN_RESERVE", "10000");
    vi.stubEnv("GENERATION_GLOBAL_DAILY_TOKENS", "20000");
    const first = acquireGenerationLease(req("ip-one")); first.recordUsage(1); first.release();
    const second = acquireGenerationLease(req("ip-two")); second.recordUsage(12000); second.release();
    expect(() => acquireGenerationLease(req("ip-three"))).toThrow("budget");
  });
  it("caps global concurrency and does not lose active leases at a day boundary", () => {
    const leases = [1, 2, 3, 4].map(id => acquireGenerationLease(req(`ip-${id}`)));
    expect(() => acquireGenerationLease(req("ip-5"))).toThrow("capacity");
    vi.advanceTimersByTime(86_400_000);
    expect(() => acquireGenerationLease(req("ip-1"))).toThrow("already running");
    leases.forEach(lease => lease.release()); expect(generationCapacity().active).toBe(0);
  });
  it("rejects new jobs during shutdown while existing leases drain", () => {
    const lease = acquireGenerationLease(req()); stopGenerationAdmission();
    expect(() => acquireGenerationLease(req("other"))).toThrow("shutting down");
    lease.release(); expect(generationCapacity().active).toBe(0);
  });
});
