import { afterEach, describe, expect, it, vi } from "vitest";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { AlipaySdk } from "alipay-sdk";
import { AlipayPaymentProvider, alipayTimestamp, amountToFen, fenToAmount } from "./provider";
import { readPaymentsConfiguration, type AlipayConfiguration } from "./config";

// Ephemeral test fixtures only, never written or used for a payment/network call.
const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const gateway = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: AlipayConfiguration = { environment: "sandbox", appId: "2026000000000001", sellerId: "2088000000000001",
  privateKey: merchant.privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
  publicKey: gateway.publicKey.export({ format: "pem", type: "spki" }).toString(), keyType: "PKCS1",
  publicBaseUrl: "https://arcane.test", gateway: "https://openapi-sandbox.dl.alipaydev.com/gateway.do" };
function elements(root: DefaultTreeAdapterMap["node"]): DefaultTreeAdapterMap["element"][] {
  return [("tagName" in root ? root : null), ...("childNodes" in root ? root.childNodes.flatMap(elements) : [])].filter(Boolean) as DefaultTreeAdapterMap["element"][];
}
function signature(fields: Record<string, string>) {
  const text = Object.keys(fields).filter(key => !["sign", "sign_type"].includes(key)).sort().map(key => `${key}=${fields[key]}`).join("&");
  return createSign("RSA-SHA256").update(text).sign(gateway.privateKey, "base64");
}
afterEach(() => vi.restoreAllMocks());
describe("official SDK adapter (offline cryptography)", () => {
  it("constructs an escaped POST form that preserves literal entities and the signed payload", () => {
    const provider = new AlipayPaymentProvider(config);
    const subject = 'ARCANE 中文“引号” &quot; &amp; <img src=x> "quote" + 100%';
    const html = provider.checkout({ orderId: "a".repeat(32), amountFen: 990, subject, expiresAt: new Date("2026-10-10T00:30:00Z") });
    const nodes = elements(parse(html)); const form = nodes.find(node => node.tagName === "form")!;
    const attrs = Object.fromEntries(form.attrs.map(item => [item.name, item.value]));
    expect(attrs.method).toBe("post"); expect(attrs.action).toBe(config.gateway);
    expect(nodes.some(node => node.tagName === "img")).toBe(false);
    const fields: Record<string, string> = Object.fromEntries(nodes.filter(node => node.tagName === "input").map(node => {
      const values = Object.fromEntries(node.attrs.map(item => [item.name, item.value])); return [values.name, values.value];
    }));
    expect(JSON.parse(fields.biz_content)).toMatchObject({ subject, total_amount: "9.90", out_trade_no: "a".repeat(32), product_code: "FAST_INSTANT_TRADE_PAY" });
    expect(fields.return_url).toBe(`https://arcane.test/billing?orderId=${"a".repeat(32)}`);
    expect(fields.notify_url).toBe("https://arcane.test/api/payments/alipay/notify");
    // Gateway request signatures include sign_type; HTML parsing must preserve every signed byte.
    const text = Object.keys(fields).filter(key => key !== "sign").sort().map(key => `${key}=${fields[key]}`).join("&");
    expect(createVerify("RSA-SHA256").update(text).verify(merchant.publicKey, fields.sign, "base64")).toBe(true);
    expect(alipayTimestamp(new Date("2026-10-10T00:30:00Z"))).toBe("2026-10-10 08:30:00");
  });
  it("uses actual SDK RSA2 verification for once-decoded Chinese/percent/plus notification values", async () => {
    const provider = new AlipayPaymentProvider(config);
    const fields = { app_id: config.appId, seller_id: config.sellerId, out_trade_no: "a".repeat(32),
      trade_no: "202610101234", total_amount: "9.90", trade_status: "TRADE_SUCCESS", subject: "100% + 中文", sign_type: "RSA2" };
    const sign = signature(fields);
    expect(await provider.verifyNotification({ ...fields, sign })).toBe(true);
    expect(await provider.verifyNotification({ ...fields, total_amount: "0.01", sign })).toBe(false);
    expect(await provider.verifyNotification({ ...fields, sign_type: "RSA", sign })).toBe(false);
  });
  it("requests response-signature verification and preserves snake-case query fields", async () => {
    const exec = vi.spyOn(AlipaySdk.prototype, "exec").mockResolvedValue({ code: "10000", out_trade_no: "a".repeat(32), trade_no: "202610101234", total_amount: "9.90", trade_status: "TRADE_SUCCESS", seller_id: config.sellerId });
    expect(await new AlipayPaymentProvider(config).query("a".repeat(32))).toMatchObject({ outTradeNo: "a".repeat(32), status: "TRADE_SUCCESS", sellerId: config.sellerId });
    expect(exec).toHaveBeenCalledWith("alipay.trade.query", { bizContent: { out_trade_no: "a".repeat(32) } }, { validateSign: true });
  });
  it("treats gateway trade-not-found as pending and unknown responses as failures", async () => {
    const exec = vi.spyOn(AlipaySdk.prototype, "exec").mockResolvedValue({ code: "40004", sub_code: "ACQ.TRADE_NOT_EXIST" });
    const provider = new AlipayPaymentProvider(config); expect(await provider.query("a".repeat(32))).toBeNull();
    exec.mockResolvedValue({ code: "10000", trade_status: "UNKNOWN" });
    await expect(provider.query("a".repeat(32))).rejects.toThrow("Payment status is temporarily unavailable.");
  });
  it("converts amount text using integer fen and rejects precision/overflow ambiguity", () => {
    expect(["9.9", "9.90", "009.90"].map(amountToFen)).toEqual([990, 990, 990]);
    expect(fenToAmount(990)).toBe("9.90");
    for (const value of ["0", "-9.90", "9.900", "9e2", "NaN", 9.9, "1000000000.00"]) expect(amountToFen(value)).toBeNull();
  });
});
describe("fail-closed payment configuration", () => {
  const env = { ALIPAY_ENABLED: "true", ALIPAY_ENV: "sandbox", ALIPAY_APP_ID: config.appId, ALIPAY_SELLER_ID: config.sellerId,
    ALIPAY_PRIVATE_KEY: config.privateKey, ALIPAY_PUBLIC_KEY: config.publicKey, PAYMENT_PUBLIC_BASE_URL: config.publicBaseUrl,
    DATABASE_URL: "mysql://mock:mock@localhost/disposable", PAYMENT_PACKAGES_JSON: JSON.stringify([{ id: "starter", name: "体验包", credits: 10, amountFen: 990, currency: "CNY" }]) };
  it("requires valid keys, a database and an explicit environment", () => {
    expect(readPaymentsConfiguration(env).configured).toBe(true);
    expect(readPaymentsConfiguration({})).toMatchObject({ configured: false, pricingConfigured: false, enabled: false });
  });
  it.each([
    { ALIPAY_ENV: "prod" }, { ALIPAY_KEY_TYPE: "PKCS9" }, { ALIPAY_PRIVATE_KEY: "your_key" },
    { ALIPAY_PUBLIC_KEY: "invalid" }, { DATABASE_URL: "https://localhost/database" },
    { PAYMENT_PUBLIC_BASE_URL: "http://production.example" }, { PAYMENT_PUBLIC_BASE_URL: "https://user:password@arcane.test" },
    { PAYMENT_PUBLIC_BASE_URL: "https://arcane.test/subpath" }, { PAYMENT_PUBLIC_BASE_URL: "https://arcane.test?redirect=1" },
  ])("refuses incomplete/mismatched configuration %j", override => expect(readPaymentsConfiguration({ ...env, ...override }).configured).toBe(false));
  it("allows local sandbox return pages but never an HTTP production deployment", () => {
    expect(readPaymentsConfiguration({ ...env, PAYMENT_PUBLIC_BASE_URL: "http://localhost:3000" }).configured).toBe(true);
    expect(readPaymentsConfiguration({ ...env, ALIPAY_ENV: "production", PAYMENT_PUBLIC_BASE_URL: "http://localhost:3000" }).configured).toBe(false);
  });
  it("keeps valid payment verification available when new sales/pricing are disabled", () => {
    expect(readPaymentsConfiguration({ ...env, ALIPAY_ENABLED: "false" })).toMatchObject({ enabled: false, configured: true, pricingConfigured: true });
    expect(readPaymentsConfiguration({ ...env, PAYMENT_PACKAGES_JSON: "[]" })).toMatchObject({ enabled: true, configured: true, pricingConfigured: false });
  });
});
