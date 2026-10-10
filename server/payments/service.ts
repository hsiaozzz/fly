import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { createPaymentOrderSchema, type CreatePaymentOrderInput, type CreditBalance, type GenerationCreditOutcome, type PaymentCatalog, type PaymentOrder } from "../../shared/payments/types";
import { readPaymentsConfiguration, type PaymentsConfiguration } from "./config";
import { AlipayPaymentProvider, amountToFen, type PaymentProvider, type VerifiedAlipayTrade } from "./provider";
import { MySqlPaymentsRepository, type PaymentsRepository, type StoredPaymentOrder } from "./repository";

const orderIdPattern = /^[a-f0-9]{32}$/;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const queryCache = new Map<string, { expires: number; promise: Promise<VerifiedAlipayTrade | null> }>();
export function resetPaymentQueriesForTests() { queryCache.clear(); }
function queryOnce(provider: PaymentProvider, scope: string, orderId: string) {
  const key = `${scope}:${orderId}`; const now = Date.now(); const prior = queryCache.get(key);
  if (prior && prior.expires > now) return prior.promise;
  if (queryCache.size >= 2000) {
    for (const [entryKey, entry] of queryCache) if (entry.expires <= now) queryCache.delete(entryKey);
    if (queryCache.size >= 2000) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "支付状态查询繁忙，请稍后再试。" });
  }
  const entry = { expires: now + 10_000, promise: Promise.resolve(null) as Promise<VerifiedAlipayTrade | null> };
  entry.promise = Promise.resolve().then(() => provider.query(orderId)).then(value => {
    entry.expires = Date.now() + 3000; return value;
  }, () => {
    if (queryCache.get(key) === entry) queryCache.delete(key);
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "支付状态暂时无法确认，请稍后重试。" });
  });
  queryCache.set(key, entry); return entry.promise;
}
function unavailable(): never {
  throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "支付宝收款尚未配置，暂时不能购买创作次数。" });
}
function orderResult(row: StoredPaymentOrder): PaymentOrder {
  return { id: row.id, packageId: row.packageId, packageName: row.packageName, credits: row.credits,
    amountFen: row.amountFen, currency: "CNY", environment: row.environment, status: row.status,
    createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), paidAt: row.paidAt?.toISOString() ?? null };
}
export function parseAlipayNotification(body: string): Record<string, string> | null {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > 65_536 || !body) return null;
  const entries = new URLSearchParams(body); const params: Record<string, string> = Object.create(null);
  let count = 0;
  for (const [key, value] of entries) {
    if (++count > 100 || !/^[A-Za-z0-9_]{1,80}$/.test(key) || value.length > 20_000 || Object.hasOwn(params, key)) return null;
    params[key] = value;
  }
  return params;
}
export class PaymentService {
  constructor(private readonly repository: PaymentsRepository, private readonly provider: PaymentProvider | null,
    private readonly configuration: PaymentsConfiguration, private readonly now: () => Date = () => new Date()) {}
  catalog(): PaymentCatalog {
    const { alipay: _alipay, ...catalog } = this.configuration;
    return structuredClone(catalog);
  }
  private requireProvider() {
    if (!this.configuration.configured || !this.configuration.alipay || !this.provider) unavailable();
    return { provider: this.provider, alipay: this.configuration.alipay };
  }
  private async ownedOrder(userId: number, id: string) {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !orderIdPattern.test(id)) throw new TRPCError({ code: "NOT_FOUND", message: "订单不存在。" });
    const order = await this.repository.findOrder(id);
    const alipay = this.configuration.alipay;
    if (!order || order.userId !== userId || !alipay || order.environment !== alipay.environment
      || order.appId !== alipay.appId || order.sellerId !== alipay.sellerId) {
      throw new TRPCError({ code: "NOT_FOUND", message: "订单不存在。" });
    }
    return order;
  }
  async createOrder(userId: number, input: CreatePaymentOrderInput) {
    const { alipay } = this.requireProvider();
    if (!this.configuration.enabled || !this.configuration.pricingConfigured) unavailable();
    const parsed = createPaymentOrderSchema.safeParse(input);
    if (!parsed.success || !Number.isSafeInteger(userId) || userId <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "订单请求不合法。" });
    const item = this.configuration.packages.find(pack => pack.id === parsed.data.packageId);
    if (!item) throw new TRPCError({ code: "BAD_REQUEST", message: "套餐不存在或已下架。" });
    const row = await this.repository.createOrder({ id: randomUUID().replaceAll("-", ""), userId,
      requestId: parsed.data.requestId, package: item, appId: alipay.appId, sellerId: alipay.sellerId,
      environment: alipay.environment, expiresAt: new Date(this.now().getTime() + 30 * 60_000) });
    return { order: orderResult(row), checkoutUrl: `/api/payments/orders/${row.id}/checkout` };
  }
  async checkout(userId: number, orderId: string) {
    const { provider } = this.requireProvider(); const order = await this.ownedOrder(userId, orderId);
    if (!this.configuration.enabled) unavailable();
    if (order.status !== "pending" || order.expiresAt <= this.now()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "订单已完成或已过期，请刷新订单状态。" });
    return provider.checkout({ orderId: order.id, amountFen: order.amountFen,
      subject: `ARCANE ${order.packageName} · ${order.credits}次创作`, expiresAt: order.expiresAt });
  }
  async getOrder(userId: number, orderId: string, options: { reconcile?: boolean } = {}) {
    const { provider, alipay } = this.requireProvider();
    let order = await this.ownedOrder(userId, orderId);
    if (options.reconcile && order.status === "pending") {
      const trade = await queryOnce(provider, `${alipay.environment}:${alipay.appId}`, order.id);
      if (trade) {
        const amountFen = amountToFen(trade.totalAmount);
        if (trade.outTradeNo !== order.id || amountFen !== order.amountFen
          || trade.sellerId !== undefined && trade.sellerId !== alipay.sellerId
          || trade.appId !== undefined && trade.appId !== alipay.appId) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "支付结果无法确认，请稍后重试。" });
        }
        await this.repository.applyTrade(order.id, { environment: alipay.environment, appId: alipay.appId,
          sellerId: alipay.sellerId, amountFen, status: trade.status, tradeNo: trade.tradeNo });
        order = await this.ownedOrder(userId, orderId);
      }
    }
    return orderResult(order);
  }
  async balance(userId: number): Promise<CreditBalance> {
    if (!this.configuration.configured) return { available: 0, reserved: 0, consumed: 0 };
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new TRPCError({ code: "UNAUTHORIZED", message: "请登录后查看创作额度。" });
    return this.repository.balance(userId);
  }
  async notify(rawFormBody: string): Promise<"success" | "fail"> {
    // All failures are finite public responses; never log signed payloads or SDK errors containing keys/URL/query data.
    try {
      const { provider, alipay } = this.requireProvider();
      const params = parseAlipayNotification(rawFormBody);
      if (!params || params.app_id !== alipay.appId || params.seller_id !== alipay.sellerId
        || params.sign_type !== "RSA2" || params.notify_type !== "trade_status_sync"
        || !params.notify_id || params.notify_id.length > 128 || !orderIdPattern.test(params.out_trade_no ?? "")
        || !params.trade_no || !["WAIT_BUYER_PAY", "TRADE_CLOSED", "TRADE_SUCCESS", "TRADE_FINISHED"].includes(params.trade_status)) return "fail";
      if (!await provider.verifyNotification(params)) return "fail";
      const order = await this.repository.findOrder(params.out_trade_no); const amountFen = amountToFen(params.total_amount);
      if (!order || order.appId !== alipay.appId || order.sellerId !== alipay.sellerId
        || order.environment !== alipay.environment || order.amountFen !== amountFen) return "fail";
      // Refunds and split-settlement events can also have TRADE_SUCCESS: do not issue credits for them.
      const nonPurchase = Boolean(params.out_biz_no || params.gmt_refund || params.refund_fee);
      const status = nonPurchase && params.trade_status !== "TRADE_CLOSED" ? "WAIT_BUYER_PAY" : params.trade_status;
      // Delivery timestamps/signatures may change on retries; business fields still identify the same event.
      const canonical = Object.keys(params).filter(key => !["sign", "notify_time"].includes(key)).sort().map(key => [key, params[key]]);
      await this.repository.applyTrade(order.id, { appId: alipay.appId, sellerId: alipay.sellerId,
        environment: alipay.environment, amountFen: amountFen!, tradeNo: params.trade_no,
        status: status as Parameters<PaymentsRepository["applyTrade"]>[1]["status"] },
      { eventKey: digest(`${alipay.environment}:${alipay.appId}:${params.notify_id}`), payloadHash: digest(JSON.stringify(canonical)) });
      return "success";
    } catch { return "fail"; }
  }
  async reserveGeneration(userId: number, taskId: string, requestHash: string) {
    if (!this.configuration.configured) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "免费额度已用完，购买创作次数后可继续。" });
    if (!Number.isSafeInteger(userId) || userId <= 0 || !/^[A-Za-z0-9_-]{8,64}$/.test(taskId) || !/^[a-f0-9]{64}$/.test(requestHash)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "创作任务标识不合法。" });
    }
    return this.repository.reserve(userId, taskId, requestHash);
  }
  async settleGeneration(userId: number, taskId: string, outcome: GenerationCreditOutcome, options: { signal?: AbortSignal } = {}) {
    if (!["success", "failed", "aborted"].includes(outcome) || !Number.isSafeInteger(userId) || userId <= 0
      || !/^[A-Za-z0-9_-]{8,64}$/.test(taskId)) throw new TRPCError({ code: "BAD_REQUEST", message: "创作结算请求不合法。" });
    return outcome === "success" && options.signal ? this.repository.settle(userId, taskId, outcome, { signal: options.signal }) : this.repository.settle(userId, taskId, outcome);
  }
}
export function getPaymentService(): PaymentService {
  const configuration = readPaymentsConfiguration();
  const repository = new MySqlPaymentsRepository({ environment: configuration.environment, appId: configuration.alipay?.appId ?? "disabled" });
  return new PaymentService(repository, configuration.configured && configuration.alipay ? new AlipayPaymentProvider(configuration.alipay) : null, configuration);
}
