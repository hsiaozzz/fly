import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentsConfiguration } from "./config";
import type { PaymentsRepository, StoredPaymentOrder } from "./repository";
import type { PaymentProvider } from "./provider";
import { PaymentService, parseAlipayNotification, resetPaymentQueriesForTests } from "./service";

const now = new Date("2026-10-10T00:00:00Z");
const item = { id: "starter", name: "体验包", credits: 10, amountFen: 990, currency: "CNY" as const };
const configuration: PaymentsConfiguration = { enabled: true, configured: true, pricingConfigured: true,
  environment: "sandbox", packages: [item], alipay: { environment: "sandbox", appId: "2026000000000001",
    sellerId: "2088000000000001", privateKey: "mock-not-a-key", publicKey: "mock-not-a-key", keyType: "PKCS1",
    publicBaseUrl: "https://arcane.test", gateway: "https://openapi-sandbox.dl.alipaydev.com/gateway.do" } };
const order: StoredPaymentOrder = { id: "0123456789abcdef0123456789abcdef", userId: 7, requestId: "request_01", packageId: item.id,
  packageName: item.name, credits: 10, amountFen: 990, currency: "CNY", environment: "sandbox", appId: configuration.alipay!.appId,
  sellerId: configuration.alipay!.sellerId, status: "pending", tradeNo: null,
  createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + 1_800_000), paidAt: null };
function setup(overrides: Partial<PaymentsConfiguration> = {}) {
  const repository: PaymentsRepository = { createOrder: vi.fn().mockResolvedValue(order), findOrder: vi.fn().mockResolvedValue(order),
    applyTrade: vi.fn().mockResolvedValue(undefined),
    balance: vi.fn().mockResolvedValue({ available: 10, reserved: 0, consumed: 0 }),
    reserve: vi.fn().mockResolvedValue({ taskId: "task_id_1", expiresAt: "2026-10-10T00:15:00Z" }), settle: vi.fn().mockResolvedValue({ available: 9, reserved: 0, consumed: 1 }) };
  const provider: PaymentProvider = { checkout: vi.fn().mockReturnValue("<form></form>"), verifyNotification: vi.fn().mockResolvedValue(true), query: vi.fn().mockResolvedValue(null) };
  return { repository, provider, service: new PaymentService(repository, provider, { ...configuration, ...overrides }, () => now) };
}
function notification(fields: Record<string, string> = {}) {
  return new URLSearchParams({ app_id: order.appId, seller_id: order.sellerId, notify_type: "trade_status_sync", notify_id: "event_1",
    sign_type: "RSA2", sign: "mock-signature", out_trade_no: order.id, trade_no: "202610101234", trade_status: "TRADE_SUCCESS",
    total_amount: "9.90", ...fields }).toString();
}
afterEach(resetPaymentQueriesForTests);
describe("server payment trust boundaries (mock gateway, no payment calls)", () => {
  it("keeps disabled/draft pricing read-only and does not touch the repository", async () => {
    const { service, repository } = setup({ configured: false, pricingConfigured: false });
    expect(service.catalog()).toMatchObject({ configured: false, pricingConfigured: false });
    expect(service.catalog()).not.toHaveProperty("alipay");
    await expect(service.createOrder(7, { packageId: "starter", requestId: "request_01" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(repository.createOrder).not.toHaveBeenCalled();
    expect(await service.balance(7)).toEqual({ available: 0, reserved: 0, consumed: 0 });
    expect(repository.balance).not.toHaveBeenCalled();
  });
  it("can disable new sales without losing existing credits, pending payment notifications or settlement", async () => {
    const { service, repository } = setup({ enabled: false, pricingConfigured: false });
    await expect(service.createOrder(7, { packageId: "starter", requestId: "request_01" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(service.checkout(7, order.id)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(repository.createOrder).not.toHaveBeenCalled();
    expect(await service.balance(7)).toEqual({ available: 10, reserved: 0, consumed: 0 });
    expect(await service.notify(notification())).toBe("success");
    await service.reserveGeneration(7, "task_id_1", "a".repeat(64));
    await service.settleGeneration(7, "task_id_1", "success");
    expect(repository.reserve).toHaveBeenCalled(); expect(repository.settle).toHaveBeenCalled();
  });
  it("uses server prices and persistent order snapshots for the owned POST checkout", async () => {
    const { service, repository, provider } = setup();
    await expect(service.createOrder(7, { packageId: "starter", requestId: "request_01", amountFen: 1 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const created = await service.createOrder(7, { packageId: "starter", requestId: "request_01" });
    expect(created.checkoutUrl).toBe(`/api/payments/orders/${order.id}/checkout`);
    expect(repository.createOrder).toHaveBeenCalledWith(expect.objectContaining({ package: item, userId: 7, environment: "sandbox" }));
    expect(created.order).not.toHaveProperty("appId");
    expect(await service.checkout(7, order.id)).toBe("<form></form>");
    expect(provider.checkout).toHaveBeenCalledWith(expect.objectContaining({ amountFen: 990, orderId: order.id }));
    await expect(service.checkout(8, order.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(provider.checkout).toHaveBeenCalledTimes(1);
  });
  it.each([
    { app_id: "2026000000000999" }, { seller_id: "2088000000000999" }, { total_amount: "0.01" },
    { total_amount: "9.900" }, { sign_type: "RSA" }, { notify_type: "fake" }, { trade_status: "SUCCESS" },
  ])("rejects forged business fields %j before credit issuance", async fields => {
    const { service, repository } = setup();
    expect(await service.notify(notification(fields))).toBe("fail");
    expect(repository.applyTrade).not.toHaveBeenCalled();
  });
  it("requires SDK signature verification, decodes form fields exactly once, and rejects repeated keys", async () => {
    const { service, provider, repository } = setup();
    vi.mocked(provider.verifyNotification).mockResolvedValue(false);
    expect(await service.notify(notification({ subject: "100% + 中文" }))).toBe("fail");
    expect(provider.verifyNotification).toHaveBeenCalledWith(expect.objectContaining({ subject: "100% + 中文" }));
    expect(repository.applyTrade).not.toHaveBeenCalled();
    expect(await service.notify(`${notification()}&total_amount=0.01`)).toBe("fail");
    expect(parseAlipayNotification("a=" + "x".repeat(65_537))).toBeNull();
  });
  it("hands verified notifications to one durable transaction without exposing the raw signature", async () => {
    const { service, repository } = setup();
    expect(await service.notify(notification())).toBe("success");
    expect(repository.applyTrade).toHaveBeenCalledWith(order.id, expect.objectContaining({ amountFen: 990, status: "TRADE_SUCCESS", appId: order.appId }),
      { eventKey: expect.stringMatching(/^[a-f0-9]{64}$/), payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const initialHash = vi.mocked(repository.applyTrade).mock.calls[0][2]!.payloadHash;
    expect(await service.notify(notification({ notify_time: "2026-10-10 08:04:00" }))).toBe("success");
    expect(vi.mocked(repository.applyTrade).mock.calls[1][2]!.payloadHash).toBe(initialHash);
    vi.mocked(repository.applyTrade).mockRejectedValue(new Error("mock DB or SDK sensitive diagnostic"));
    expect(await service.notify(notification())).toBe("fail");
  });
  it.each([{ out_biz_no: "refund_1" }, { gmt_refund: "2026-10-10 08:00:00" }, { refund_fee: "9.90" }])("does not issue purchase credits for refund/split events %j", async fields => {
    const { service, repository } = setup();
    expect(await service.notify(notification(fields))).toBe("success");
    expect(repository.applyTrade).toHaveBeenCalledWith(order.id, expect.objectContaining({ status: "WAIT_BUYER_PAY" }), expect.anything());
  });
  it("coalesces gateway status queries across service instances, while ownership remains mandatory", async () => {
    const { service, provider, repository } = setup();
    const second = new PaymentService(repository, provider, configuration, () => now);
    await Promise.all([service.getOrder(7, order.id, { reconcile: true }), second.getOrder(7, order.id, { reconcile: true })]);
    expect(provider.query).toHaveBeenCalledTimes(1);
    await expect(second.getOrder(8, order.id, { reconcile: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(provider.query).toHaveBeenCalledTimes(1);
  });
  it.each([{ totalAmount: "0.01" }, { sellerId: "2088000000000999" }, { appId: "2026000000000999" }, { outTradeNo: "other_order" }])("does not trust a query with mismatched fields %j", async override => {
    const { service, provider, repository } = setup();
    vi.mocked(provider.query).mockResolvedValue({ outTradeNo: order.id, tradeNo: "202610101234", status: "TRADE_SUCCESS", totalAmount: "9.90", ...override });
    await expect(service.getOrder(7, order.id, { reconcile: true })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(repository.applyTrade).not.toHaveBeenCalled();
  });
  it("confirms a paid query using its integer amount and scopes it to the current app", async () => {
    const { service, provider, repository } = setup();
    vi.mocked(provider.query).mockResolvedValue({ outTradeNo: order.id, tradeNo: "202610101234", status: "TRADE_SUCCESS", totalAmount: "9.9" });
    await service.getOrder(7, order.id, { reconcile: true });
    expect(repository.applyTrade).toHaveBeenCalledWith(order.id, expect.objectContaining({ amountFen: 990, environment: "sandbox", appId: order.appId }));
    vi.mocked(repository.findOrder).mockResolvedValue({ ...order, environment: "production" });
    await expect(service.getOrder(7, order.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("never exposes gateway diagnostics when query fails", async () => {
    const { service, provider } = setup();
    vi.mocked(provider.query).mockRejectedValue(new Error("mock URL sign/private data"));
    await expect(service.getOrder(7, order.id, { reconcile: true })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "支付状态暂时无法确认，请稍后重试。" });
  });
  it("validates task identity and delegates durable reserve/settlement without changing token caps", async () => {
    const { service, repository } = setup();
    await expect(service.reserveGeneration(7, "bad", "x")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await service.reserveGeneration(7, "task_id_1", "a".repeat(64));
    expect(repository.reserve).toHaveBeenCalledWith(7, "task_id_1", "a".repeat(64));
    await service.settleGeneration(7, "task_id_1", "failed");
    expect(repository.settle).toHaveBeenCalledWith(7, "task_id_1", "failed");
  });
  it("forwards success cancellation to the transaction but never prevents failure/abort release", async () => {
    const { service, repository } = setup(); const abort = new AbortController();
    await service.settleGeneration(7, "task_id_1", "success", { signal: abort.signal });
    expect(repository.settle).toHaveBeenCalledWith(7, "task_id_1", "success", { signal: abort.signal });
    abort.abort();
    await service.settleGeneration(7, "task_id_1", "aborted", { signal: abort.signal });
    expect(repository.settle).toHaveBeenLastCalledWith(7, "task_id_1", "aborted");
  });
});
