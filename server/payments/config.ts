import { createPrivateKey, createPublicKey } from "node:crypto";
import { paymentPackageSchema, type PaymentCatalog, type PaymentEnvironment, type PaymentPackage } from "../../shared/payments/types";

export type AlipayConfiguration = {
  environment: PaymentEnvironment;
  appId: string;
  privateKey: string;
  publicKey: string;
  sellerId: string;
  keyType: "PKCS1" | "PKCS8";
  publicBaseUrl: string;
  gateway: string;
};
export type PaymentsConfiguration = PaymentCatalog & { alipay: AlipayConfiguration | null };

// Draft product suggestions are visible while disabled; they never authorize a sale.
const draftPackages: PaymentPackage[] = [
  { id: "starter", name: "创作体验包", credits: 10, amountFen: 990, currency: "CNY" },
  { id: "creator", name: "创作者套餐", credits: 50, amountFen: 3990, currency: "CNY" },
];
function present(value: string | undefined): value is string {
  return Boolean(value?.trim()) && !/placeholder|replace[_ -]?me|your[_ -]|example|请填写|<|>/i.test(value!);
}
function readPackages(raw: string | undefined): PaymentPackage[] | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = paymentPackageSchema.array().min(1).max(10).parse(JSON.parse(raw!));
    return new Set(parsed.map(item => item.id)).size === parsed.length ? parsed : null;
  } catch { return null; }
}
function validKeys(privateKey: string, publicKey: string, keyType: "PKCS1" | "PKCS8") {
  try {
    const privateObject = createPrivateKey(privateKey.includes("-----BEGIN") ? privateKey : {
      key: Buffer.from(privateKey, "base64"), format: "der", type: keyType === "PKCS8" ? "pkcs8" : "pkcs1",
    });
    const publicObject = createPublicKey(publicKey.includes("-----BEGIN") ? publicKey : {
      key: Buffer.from(publicKey, "base64"), format: "der", type: "spki",
    });
    return privateObject.asymmetricKeyType === "rsa" && publicObject.asymmetricKeyType === "rsa"
      && (privateObject.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048
      && (publicObject.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048;
  } catch { return false; }
}
export function readPaymentsConfiguration(env: NodeJS.ProcessEnv = process.env): PaymentsConfiguration {
  const enabled = env.ALIPAY_ENABLED === "true";
  const environment: PaymentEnvironment = env.ALIPAY_ENV === "production" ? "production" : "sandbox";
  const packages = readPackages(env.PAYMENT_PACKAGES_JSON);
  const keyType = env.ALIPAY_KEY_TYPE === "PKCS8" ? "PKCS8" : "PKCS1";
  let databaseConfigured = false;
  try {
    const database = new URL(env.DATABASE_URL ?? "");
    databaseConfigured = database.protocol === "mysql:" && Boolean(database.hostname && database.pathname.length > 1) && present(env.DATABASE_URL);
  } catch { /* No valid database configuration. */ }
  let alipay: AlipayConfiguration | null = null;
  if (["sandbox", "production"].includes(env.ALIPAY_ENV ?? "")
    && (env.ALIPAY_KEY_TYPE === undefined || ["PKCS1", "PKCS8"].includes(env.ALIPAY_KEY_TYPE))
    && /^\d{16,32}$/.test(env.ALIPAY_APP_ID ?? "") && /^\d{16,30}$/.test(env.ALIPAY_SELLER_ID ?? "")
    && present(env.ALIPAY_PRIVATE_KEY) && present(env.ALIPAY_PUBLIC_KEY) && present(env.PAYMENT_PUBLIC_BASE_URL)) {
    try {
      const base = new URL(env.PAYMENT_PUBLIC_BASE_URL);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
      if (!base.username && !base.password && !base.search && !base.hash && base.pathname === "/"
        && (base.protocol === "https:" || environment === "sandbox" && local && base.protocol === "http:")
        && validKeys(env.ALIPAY_PRIVATE_KEY, env.ALIPAY_PUBLIC_KEY, keyType)) {
        alipay = { environment, appId: env.ALIPAY_APP_ID!, privateKey: env.ALIPAY_PRIVATE_KEY,
          publicKey: env.ALIPAY_PUBLIC_KEY, sellerId: env.ALIPAY_SELLER_ID!, keyType,
          publicBaseUrl: base.origin,
          gateway: environment === "production" ? "https://openapi.alipay.com/gateway.do" : "https://openapi-sandbox.dl.alipaydev.com/gateway.do" };
      }
    } catch { /* Invalid public configuration disables checkout. */ }
  }
  return { enabled, configured: Boolean(alipay && databaseConfigured), environment,
    pricingConfigured: Boolean(packages), packages: packages ?? structuredClone(draftPackages), alipay };
}
