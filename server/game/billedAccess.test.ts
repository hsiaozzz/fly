import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { TRPCError } from "@trpc/server";
const payment = vi.hoisted(() => ({ catalog: vi.fn(), reserveGeneration: vi.fn(), settleGeneration: vi.fn() }));
vi.mock("../payments/service", () => ({ getPaymentService: () => payment }));
import { acquireBilledGenerationLease } from "./billedAccess";
import { generationCapacity, resetGenerationLimitsForTests } from "./access";
const req = { ip: "billing-fixture" } as Request;
beforeEach(() => {
  vi.resetAllMocks(); resetGenerationLimitsForTests();
  payment.catalog.mockReturnValue({ configured: true });
  payment.reserveGeneration.mockResolvedValue({}); payment.settleGeneration.mockResolvedValue({});
});
afterEach(() => { vi.unstubAllEnvs(); resetGenerationLimitsForTests(); });
describe("purchased generation admission", () => {
  it("uses free allowance without a database dependency", async () => {
    const lease = await acquireBilledGenerationLease(req, { id: 3 }, { prompt: "fixture" });
    await lease.success(); await lease.release();
    expect(payment.catalog).not.toHaveBeenCalled(); expect(payment.reserveGeneration).not.toHaveBeenCalled();
    expect(generationCapacity().active).toBe(0);
  });
  it("reserves one durable credit and settles once before success", async () => {
    vi.stubEnv("GENERATION_USER_DAILY_LIMIT", "0");
    const lease = await acquireBilledGenerationLease(req, { id: 3 }, { prompt: "private fixture" });
    expect(payment.reserveGeneration).toHaveBeenCalledWith(3, expect.any(String), expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(JSON.stringify(payment.reserveGeneration.mock.calls)).not.toContain("private fixture");
    await lease.success(); await lease.success(); await lease.release();
    expect(payment.settleGeneration).toHaveBeenCalledTimes(1);
    expect(payment.settleGeneration).toHaveBeenCalledWith(3, expect.any(String), "success");
    expect(generationCapacity().active).toBe(0);
  });
  it.each(["failed", "aborted"] as const)("returns a reservation on %s", async outcome => {
    vi.stubEnv("GENERATION_USER_DAILY_LIMIT", "0");
    const lease = await acquireBilledGenerationLease(req, { id: 3 }, { prompt: "fixture" });
    await lease.release(outcome); await lease.release(outcome);
    expect(payment.settleGeneration).toHaveBeenCalledTimes(1);
    expect(payment.settleGeneration).toHaveBeenCalledWith(3, expect.any(String), outcome);
    expect(generationCapacity().active).toBe(0);
  });
  it("releases capacity when an empty account rejects admission", async () => {
    vi.stubEnv("GENERATION_USER_DAILY_LIMIT", "0");
    payment.reserveGeneration.mockRejectedValue(new TRPCError({ code: "PRECONDITION_FAILED", message: "No credits" }));
    await expect(acquireBilledGenerationLease(req, { id: 3 }, {})).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(generationCapacity().active).toBe(0); expect(payment.settleGeneration).not.toHaveBeenCalled();
  });
  it("keeps global token caps and anonymous limits ahead of paid admission", async () => {
    vi.stubEnv("GENERATION_USER_DAILY_LIMIT", "0"); vi.stubEnv("GENERATION_GLOBAL_DAILY_TOKENS", "1");
    await expect(acquireBilledGenerationLease(req, { id: 3 }, {})).rejects.toThrow("budget");
    expect(payment.reserveGeneration).not.toHaveBeenCalled();
    vi.stubEnv("GENERATION_GLOBAL_DAILY_TOKENS", "2000000"); vi.stubEnv("GENERATION_ANON_DAILY_LIMIT", "0");
    await expect(acquireBilledGenerationLease(req, null, {})).rejects.toThrow("Anonymous allowance");
    expect(payment.reserveGeneration).not.toHaveBeenCalled();
  });
  it("retains the free-limit error when billing is disabled", async () => {
    vi.stubEnv("GENERATION_USER_DAILY_LIMIT", "0"); payment.catalog.mockReturnValue({ configured: false });
    await expect(acquireBilledGenerationLease(req, { id: 3 }, {})).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(payment.reserveGeneration).not.toHaveBeenCalled();
  });
});
