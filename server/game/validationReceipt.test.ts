import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactDigest } from "../../shared/game/artifact";
import type { GameArtifact } from "../../shared/game/types";
import type { ValidationReport } from "../../shared/game/validation";
const artifact: GameArtifact = { title: "Receipt", description: "", controls: [], files: [{ path: "index.html", content: "<canvas></canvas>", language: "html" }] };
beforeEach(() => { vi.resetModules(); vi.stubEnv("JWT_SECRET", "test-only-long-random-value-1234567890"); vi.stubEnv("VITE_APP_ID", "test-app"); });
describe("server validation receipts", () => {
  it("attests only passed exact source hashes without embedding screenshots", async () => {
    const { issueValidationReceipt, verifyValidationReceipt } = await import("./validationReceipt");
    const report: ValidationReport = { schemaVersion: 1, artifactHash: await artifactDigest(artifact), status: "passed", checks: [], errors: [], durationMs: 1, testedAt: new Date().toISOString(), environment: { runner: "playwright", viewport: { width: 800, height: 600 }, seed: 1 }, evidence: { screenshotDataUrl: "data:image/png;base64," + "x".repeat(100_000) } };
    const receipt = await issueValidationReceipt(artifact, report);
    expect(receipt).toBeTruthy(); expect(receipt!.length).toBeLessThan(1024);
    expect(await verifyValidationReceipt(artifact, receipt!)).toBe(true);
    expect(await verifyValidationReceipt({ ...artifact, title: "changed" }, receipt!)).toBe(false);
    expect(await issueValidationReceipt(artifact, { ...report, status: "unverified" })).toBeNull();
    expect(await issueValidationReceipt(artifact, { ...report, artifactHash: "wrong" })).toBeNull();
  });
});
