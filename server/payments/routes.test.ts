import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import { TRPCError } from "@trpc/server";
import { HttpError } from "../../shared/_core/errors";
import type { TrpcContext } from "../_core/context";
const fixtures = vi.hoisted(() => ({ authenticate: vi.fn(), service: {
  catalog: vi.fn(), balance: vi.fn(), createOrder: vi.fn(), getOrder: vi.fn(), checkout: vi.fn(), notify: vi.fn(),
} }));
vi.mock("../_core/sdk", () => ({ sdk: { authenticateRequest: fixtures.authenticate } }));
vi.mock("./service", () => ({ getPaymentService: () => fixtures.service }));
import { billingRouter, registerPaymentRoutes } from "./routes";
let server: Server; let base: string;
const orderId = "a".repeat(32);
beforeEach(async () => {
  vi.resetAllMocks(); fixtures.authenticate.mockResolvedValue({ id: 7 });
  fixtures.service.notify.mockResolvedValue("success"); fixtures.service.checkout.mockResolvedValue('<form action="https://openapi.alipay.com/gateway.do"></form>');
  const app = express(); registerPaymentRoutes(app); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
  server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
describe("Alipay transport and owned orders", () => {
  it("preserves exact raw form body independently of login", async () => {
    const form = "subject=A%2BB+%E5%88%9B%E4%BD%9C&sign=encoded%2Bsignature&out_trade_no=" + orderId;
    const response = await fetch(`${base}/api/payments/alipay/notify`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    expect(response.status).toBe(200); expect(await response.text()).toBe("success");
    expect(fixtures.service.notify).toHaveBeenCalledWith(form); expect(fixtures.authenticate).not.toHaveBeenCalled();
  });
  it("rejects JSON callbacks and oversized forms before service code", async () => {
    const response = await fetch(`${base}/api/payments/alipay/notify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{}' });
    expect(response.status).toBe(400);
    const large = await fetch(`${base}/api/payments/alipay/notify`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: 'sign=' + 'x'.repeat(65536) });
    expect(large.status).toBe(413); expect(fixtures.service.notify).not.toHaveBeenCalled();
  });
  it("serves owned form HTML with checkout-specific CSP and no cache", async () => {
    const response = await fetch(`${base}/api/payments/orders/${orderId}/checkout`);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(fixtures.service.checkout).toHaveBeenCalledWith(7, orderId);
  });
  it("blocks anonymous checkout and returns a neutral ownership error", async () => {
    fixtures.authenticate.mockRejectedValueOnce(new HttpError(401, "private auth detail"));
    const anonymous = await fetch(`${base}/api/payments/orders/${orderId}/checkout`);
    expect(anonymous.status).toBe(401); expect(fixtures.service.checkout).not.toHaveBeenCalled();
    fixtures.service.checkout.mockRejectedValueOnce(new TRPCError({ code: "NOT_FOUND", message: "private owner" }));
    const other = await fetch(`${base}/api/payments/orders/${orderId}/checkout`);
    expect(other.status).toBe(404); expect(await other.text()).not.toContain("private owner");
  });
  it("protects balance/order procedures and always reconciles owned queries", async () => {
    const anonymous = billingRouter.createCaller({ user: null } as TrpcContext);
    await expect(anonymous.balance()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.createOrder({ packageId: "starter", requestId: "request-fixture" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const caller = billingRouter.createCaller({ user: { id: 7 } } as TrpcContext);
    await caller.getOrder({ orderId });
    expect(fixtures.service.getOrder).toHaveBeenCalledWith(7, orderId, { reconcile: true });
    await expect(caller.createOrder({ packageId: "starter", requestId: "request-fixture", amountFen: 1 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fixtures.service.createOrder).not.toHaveBeenCalled();
  });
  it("does not expose database or SDK details in payment RPC errors", async () => {
    fixtures.service.balance.mockRejectedValue(new Error("private connection and SQL detail"));
    const caller = billingRouter.createCaller({ user: { id: 7 } } as TrpcContext);
    await expect(caller.balance()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "付款与额度服务暂时不可用，请稍后重试。" });
  });
});
