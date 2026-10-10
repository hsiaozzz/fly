import { z } from "zod";

export const paymentPackageSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  name: z.string().min(1).max(80),
  credits: z.number().int().min(1).max(100_000),
  amountFen: z.number().int().min(1).max(10_000_000),
  currency: z.literal("CNY"),
}).strict();
export type PaymentPackage = z.infer<typeof paymentPackageSchema>;

export const createPaymentOrderSchema = z.object({
  packageId: paymentPackageSchema.shape.id,
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
}).strict();
export type CreatePaymentOrderInput = z.infer<typeof createPaymentOrderSchema>;

export type PaymentEnvironment = "sandbox" | "production";
export type PaymentOrderStatus = "pending" | "paid" | "closed";
export type PaymentOrder = {
  id: string;
  packageId: string;
  packageName: string;
  credits: number;
  amountFen: number;
  currency: "CNY";
  environment: PaymentEnvironment;
  status: PaymentOrderStatus;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
};
export type CreditBalance = { available: number; reserved: number; consumed: number };
export type PaymentCatalog = {
  enabled: boolean;
  configured: boolean;
  environment: PaymentEnvironment;
  pricingConfigured: boolean;
  packages: PaymentPackage[];
};
export type GenerationCreditOutcome = "success" | "failed" | "aborted";
