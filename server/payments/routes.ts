import express, { type Express } from "express";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { sdk } from "../_core/sdk";
import { HttpError } from "../../shared/_core/errors";
import { createPaymentOrderSchema } from "../../shared/payments/types";
import { getPaymentService } from "./service";
import { logError } from "../_core/logger";

const orderId = z.string().regex(/^[a-f0-9]{32}$/);
async function publicPaymentResult<T>(action: () => T | Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof TRPCError) throw error;
    logError("payment.request.failed", error);
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "付款与额度服务暂时不可用，请稍后重试。" });
  }
}
export const billingRouter = router({
  catalog: publicProcedure.query(({ ctx }) => { ctx.res?.setHeader?.("Cache-Control", "no-store"); return getPaymentService().catalog(); }),
  balance: protectedProcedure.query(({ ctx }) => { ctx.res?.setHeader?.("Cache-Control", "no-store"); return publicPaymentResult(() => getPaymentService().balance(ctx.user.id)); }),
  createOrder: protectedProcedure.input(createPaymentOrderSchema).mutation(({ ctx, input }) => publicPaymentResult(() => getPaymentService().createOrder(ctx.user.id, input))),
  getOrder: protectedProcedure.input(z.object({ orderId }).strict()).query(({ ctx, input }) => { ctx.res?.setHeader?.("Cache-Control", "no-store"); return publicPaymentResult(() => getPaymentService().getOrder(ctx.user.id, input.orderId, { reconcile: true })); }),
});

/** Register before global body parsers: Alipay signatures cover the original form fields. */
export function registerPaymentRoutes(app: Express): void {
  app.post("/api/payments/alipay/notify", express.text({ type: "application/x-www-form-urlencoded", limit: "64kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.is("application/x-www-form-urlencoded") || typeof req.body !== "string") {
      res.status(400).type("text/plain").send("fail"); return;
    }
    try {
      const result = await getPaymentService().notify(req.body);
      res.status(result === "success" ? 200 : 400).type("text/plain").send(result);
    } catch (error) { logError("payment.notify.failed", error); res.status(503).type("text/plain").send("fail"); }
  });
  app.get("/api/payments/orders/:orderId/checkout", async (req, res) => {
    res.set({
      "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; form-action https://openapi.alipay.com https://openapi-sandbox.dl.alipaydev.com; base-uri 'none'; frame-ancestors 'none'",
    });
    if (!orderId.safeParse(req.params.orderId).success) { res.status(400).type("text/plain").send("订单格式不合法。"); return; }
    try {
      const user = await sdk.authenticateRequest(req);
      const html = await getPaymentService().checkout(user.id, req.params.orderId);
      res.type("html").send(html);
    } catch (error) {
      const unauthenticated = error instanceof HttpError && [401, 403].includes(error.statusCode);
      const code = error instanceof TRPCError ? error.code : undefined;
      const status = unauthenticated || code === "UNAUTHORIZED" ? 401 : code === "NOT_FOUND" ? 404 : code === "CONFLICT" || code === "PRECONDITION_FAILED" ? 409 : 503;
      if (status === 503) logError("payment.checkout.failed", error);
      res.status(status).type("text/plain").send(status === 401 ? "请登录后重新打开付款页面。" : status === 404 ? "订单不存在。" : status === 409 ? "订单已完成或关闭，请返回检查状态。" : "付款服务暂时不可用，请返回重试。");
    }
  });
}
