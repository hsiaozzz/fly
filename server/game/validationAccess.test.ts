import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { acquireGenerationLease, generationCapacity, resetGenerationLimitsForTests } from "./access";
import { acquireValidationLease, resetValidationLimitsForTests, stopValidationAdmission, validationCapacity } from "./validationAccess";

beforeEach(() => {
  resetValidationLimitsForTests(); resetGenerationLimitsForTests();
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-10T01:00:00Z"));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("independent browser validation admission", () => {
  it("requires an authenticated user and retains a single per-user lease", () => {
    expect(() => acquireValidationLease(0)).toThrow("Sign in");
    const lease = acquireValidationLease(1);
    expect(() => acquireValidationLease(1)).toThrow("already running");
    lease.release(); lease.release(); expect(validationCapacity().active).toBe(0);
    acquireValidationLease(1).release();
  });
  it("caps the browser pool at two without sharing active jobs or tokens with generation", () => {
    vi.stubEnv("VALIDATION_GLOBAL_CONCURRENCY", "100");
    vi.stubEnv("GENERATION_GLOBAL_DAILY_TOKENS", "64000");
    const jobs = [acquireValidationLease(1), acquireValidationLease(2)];
    expect(() => acquireValidationLease(3)).toThrow("capacity");
    const model = acquireGenerationLease({ ip: "test-model" } as Request, { id: 1 });
    expect(generationCapacity().active).toBe(1); expect(validationCapacity().active).toBe(2);
    jobs.forEach(job => job.release()); model.release();
    expect(() => acquireGenerationLease({ ip: "test-model-2" } as Request, { id: 4 })).toThrow("budget");
  });
  it("keeps per-user validation counts after failed/cancelled jobs release concurrency", () => {
    vi.stubEnv("VALIDATION_USER_DAILY_LIMIT", "2");
    acquireValidationLease(1).release(); acquireValidationLease(1).release();
    expect(() => acquireValidationLease(1)).toThrow("Daily browser");
    acquireValidationLease(2).release();
  });
  it("enforces the global daily browser allowance across users", () => {
    vi.stubEnv("VALIDATION_GLOBAL_DAILY_LIMIT", "2");
    acquireValidationLease(1).release(); acquireValidationLease(2).release();
    expect(() => acquireValidationLease(3)).toThrow("Server browser");
  });
  it("resets the daily allowance at UTC midnight while retaining active leases", () => {
    vi.stubEnv("VALIDATION_USER_DAILY_LIMIT", "1");
    const active = acquireValidationLease(1);
    vi.advanceTimersByTime(86_400_000);
    expect(() => acquireValidationLease(1)).toThrow("already running");
    active.release(); acquireValidationLease(1).release();
    expect(validationCapacity().active).toBe(0);
  });
  it("stops new browser jobs during shutdown while retaining existing jobs", () => {
    const active = acquireValidationLease(1); stopValidationAdmission();
    expect(() => acquireValidationLease(2)).toThrow("shutting down");
    expect(validationCapacity()).toEqual({ active: 1, draining: true });
    active.release(); expect(validationCapacity().active).toBe(0);
  });
  it("allows operators to disable browser jobs without disabling generation", () => {
    vi.stubEnv("VALIDATION_GLOBAL_CONCURRENCY", "0");
    expect(() => acquireValidationLease(1)).toThrow("capacity");
    acquireGenerationLease({ ip: "test-model" } as Request).release();
  });
});
