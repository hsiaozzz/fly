import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";
import { acquireGenerationLease, GenerationAllowanceError } from "./access";
import { getPaymentService } from "../payments/service";
import { TRPCError } from "@trpc/server";
import { logError } from "../_core/logger";

async function creditOperation<T>(run: () => Promise<T>) {
  try { return await run(); }
  catch (error) {
    if (error instanceof TRPCError) throw error;
    logError("generation.credit.failed", error);
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "创作额度暂时无法确认，请稍后重试。" });
  }
}

/** Shared by RPC and SSE: free allowance first, then durable purchased credit. */
export async function acquireBilledGenerationLease(req: Request, user: { id: number } | null | undefined, request: unknown) {
  let admission: ReturnType<typeof acquireGenerationLease>;
  let paid: { userId: number; taskId: string } | undefined;
  let payment: ReturnType<typeof getPaymentService> | undefined;
  try { admission = acquireGenerationLease(req, user); }
  catch (error) {
    if (!(error instanceof GenerationAllowanceError) || !user || user.id <= 0) throw error;
    payment = getPaymentService();
    // Disabled billing retains the original free allowance response and avoids DB work.
    if (!payment.catalog().configured) throw error;
    admission = acquireGenerationLease(req, user, { paidCredit: true });
    const taskId = randomUUID();
    try {
      await creditOperation(() => payment!.reserveGeneration(user.id, taskId, createHash("sha256").update(JSON.stringify(request)).digest("hex")));
      paid = { userId: user.id, taskId };
    } catch (failure) { admission.release(); throw failure; }
  }
  let settled = false;
  return {
    recordUsage: (tokens: number) => admission.recordUsage(tokens),
    async success(signal?: AbortSignal) {
      if (settled) return;
      signal?.throwIfAborted();
      if (paid) await creditOperation(() => signal
        ? payment!.settleGeneration(paid!.userId, paid!.taskId, "success", { signal })
        : payment!.settleGeneration(paid!.userId, paid!.taskId, "success"));
      settled = true;
    },
    async release(outcome: "failed" | "aborted" = "failed") {
      try {
        if (!settled && paid) {
          await creditOperation(() => payment!.settleGeneration(paid!.userId, paid!.taskId, outcome));
          settled = true;
        }
      } finally { admission.release(); }
    },
  };
}
