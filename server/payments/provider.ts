import { AlipaySdk } from "alipay-sdk";
import type { AlipayConfiguration } from "./config";

export type VerifiedAlipayTrade = {
  outTradeNo: string;
  tradeNo: string;
  status: "WAIT_BUYER_PAY" | "TRADE_CLOSED" | "TRADE_SUCCESS" | "TRADE_FINISHED";
  totalAmount: string;
  sellerId?: string;
  appId?: string;
};
export interface PaymentProvider {
  checkout(input: { orderId: string; amountFen: number; subject: string; expiresAt: Date }): string;
  verifyNotification(params: Record<string, string>): Promise<boolean>;
  query(orderId: string): Promise<VerifiedAlipayTrade | null>;
}
export function amountToFen(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}
export function fenToAmount(fen: number): string {
  if (!Number.isSafeInteger(fen) || fen <= 0) throw new Error("Invalid payment amount.");
  return `${Math.floor(fen / 100)}.${String(fen % 100).padStart(2, "0")}`;
}
export function alipayTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
}
function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export class AlipayPaymentProvider implements PaymentProvider {
  private readonly sdk: AlipaySdk;
  constructor(private readonly configuration: AlipayConfiguration) {
    this.sdk = new AlipaySdk({ appId: configuration.appId, privateKey: configuration.privateKey,
      alipayPublicKey: configuration.publicKey, keyType: configuration.keyType, gateway: configuration.gateway,
      signType: "RSA2", timeout: 8000, camelcase: false });
  }
  checkout(input: { orderId: string; amountFen: number; subject: string; expiresAt: Date }) {
    const { publicBaseUrl } = this.configuration;
    const options = {
      returnUrl: `${publicBaseUrl}/billing?orderId=${encodeURIComponent(input.orderId)}`,
      bizContent: { out_trade_no: input.orderId, total_amount: fenToAmount(input.amountFen),
        subject: input.subject, product_code: "FAST_INSTANT_TRADE_PAY", time_expire: alipayTimestamp(input.expiresAt) },
      ...(publicBaseUrl.startsWith("https:") ? { notifyUrl: `${publicBaseUrl}/api/payments/alipay/notify` } : {}),
    };
    // SDK 4.14.0's POST renderer only escapes quotes. Signing the URL locally
    // and encoding every field ourselves preserves literal HTML entities in the
    // signed JSON. The browser still submits POST; no gateway GET is performed.
    const signed = new URL(this.sdk.pageExec("alipay.trade.page.pay", "GET", options));
    const gateway = new URL(this.configuration.gateway);
    if (signed.origin !== gateway.origin || signed.pathname !== gateway.pathname || signed.username || signed.password || signed.hash) {
      throw new Error("Invalid payment gateway form.");
    }
    const seen = new Set<string>();
    const inputs = [...signed.searchParams].map(([name, value]) => {
      if (seen.has(name)) throw new Error("Invalid payment gateway form.");
      seen.add(name);
      return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
    }).join("");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>ARCANE 付款</title></head><body><p>正在打开支付宝收银台…</p><form id="arcane-alipay-checkout" method="post" accept-charset="UTF-8" action="${escapeHtml(gateway.href)}">${inputs}<button type="submit">继续前往支付宝</button></form><script>HTMLFormElement.prototype.submit.call(document.getElementById("arcane-alipay-checkout"));</script></body></html>`;
  }
  async verifyNotification(params: Record<string, string>) {
    if (params.sign_type !== "RSA2") return false;
    return this.sdk.checkNotifySignV2(params);
  }
  async query(orderId: string): Promise<VerifiedAlipayTrade | null> {
    // A server reply is trusted only after SDK response-signature verification.
    const result = await this.sdk.exec("alipay.trade.query", { bizContent: { out_trade_no: orderId } }, { validateSign: true });
    if (result.code === "40004" && result.sub_code === "ACQ.TRADE_NOT_EXIST") return null;
    if (result.code !== "10000" || typeof result.out_trade_no !== "string" || typeof result.trade_no !== "string"
      || typeof result.total_amount !== "string" || !["WAIT_BUYER_PAY", "TRADE_CLOSED", "TRADE_SUCCESS", "TRADE_FINISHED"].includes(result.trade_status)) {
      throw new Error("Payment status is temporarily unavailable.");
    }
    return { outTradeNo: result.out_trade_no, tradeNo: result.trade_no,
      status: result.trade_status as VerifiedAlipayTrade["status"], totalAmount: result.total_amount,
      ...(typeof result.seller_id === "string" ? { sellerId: result.seller_id } : {}),
      ...(typeof result.app_id === "string" ? { appId: result.app_id } : {}) };
  }
}
