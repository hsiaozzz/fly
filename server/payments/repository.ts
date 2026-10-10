import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { creditAccounts, creditLedger, generationCreditReservations, paymentNotifications, paymentOrders } from "../../drizzle/schema";
import type { CreditBalance, GenerationCreditOutcome, PaymentEnvironment, PaymentPackage } from "../../shared/payments/types";
import { getDb } from "../db";

export type StoredPaymentOrder = typeof paymentOrders.$inferSelect;
export type NewPaymentOrder = { id: string; userId: number; requestId: string; package: PaymentPackage;
  environment: PaymentEnvironment; appId: string; sellerId: string; expiresAt: Date };
export type PaymentEvidence = { environment: PaymentEnvironment; appId: string; sellerId: string;
  amountFen: number; tradeNo: string; status: "WAIT_BUYER_PAY" | "TRADE_CLOSED" | "TRADE_SUCCESS" | "TRADE_FINISHED" };
export type NotificationEvent = { eventKey: string; payloadHash: string };
export interface PaymentsRepository {
  createOrder(input: NewPaymentOrder): Promise<StoredPaymentOrder>;
  findOrder(orderId: string): Promise<StoredPaymentOrder | null>;
  applyTrade(orderId: string, evidence: PaymentEvidence, notification?: NotificationEvent): Promise<void>;
  balance(userId: number): Promise<CreditBalance>;
  reserve(userId: number, taskId: string, requestHash: string): Promise<{ taskId: string; expiresAt: string }>;
  settle(userId: number, taskId: string, outcome: GenerationCreditOutcome, options?: { signal?: AbortSignal }): Promise<CreditBalance>;
}
type Database = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type AccountScope = { environment: PaymentEnvironment; appId: string };
function accountWhere(userId: number, scope: AccountScope) {
  return and(eq(creditAccounts.userId, userId), eq(creditAccounts.environment, scope.environment), eq(creditAccounts.appId, scope.appId));
}
function reservationWhere(userId: number, scope: AccountScope) {
  return and(eq(generationCreditReservations.userId, userId), eq(generationCreditReservations.environment, scope.environment), eq(generationCreditReservations.appId, scope.appId));
}
const maxAccountCount = 2_000_000_000;
const reservationLifetimeMs = 15 * 60_000; // Generation is bounded to five minutes elsewhere.
async function database() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "创作额度服务尚未配置。" });
  return db;
}
function balanceOf(row: CreditBalance): CreditBalance {
  return { available: row.available, reserved: row.reserved, consumed: row.consumed };
}
async function lockAccount(tx: Transaction, userId: number, scope: AccountScope) {
  await tx.insert(creditAccounts).values({ userId, ...scope }).onDuplicateKeyUpdate({ set: { userId: sql`${creditAccounts.userId}` } });
  return (await tx.select().from(creditAccounts).where(accountWhere(userId, scope)).limit(1).for("update"))[0];
}
async function ledger(tx: Transaction, userId: number, scope: AccountScope, eventKey: string, kind: typeof creditLedger.$inferInsert.kind,
  referenceId: string, availableDelta: number, reservedDelta: number, consumedDelta: number) {
  await tx.insert(creditLedger).values({ id: randomUUID(), userId, ...scope, eventKey, kind, referenceId, availableDelta, reservedDelta, consumedDelta });
}
async function releaseExpired(tx: Transaction, account: typeof creditAccounts.$inferSelect, now: Date) {
  const expired = await tx.select().from(generationCreditReservations).where(and(
    reservationWhere(account.userId, account), eq(generationCreditReservations.state, "reserved"),
    lte(generationCreditReservations.expiresAt, now))).limit(100).for("update");
  if (!expired.length) return account;
  if (account.reserved < expired.length) throw new Error("Credit account requires reconciliation.");
  for (const reservation of expired) {
    await tx.update(generationCreditReservations).set({ state: "released", outcome: "expired", settledAt: now }).where(eq(generationCreditReservations.id, reservation.id));
    await ledger(tx, account.userId, account, `reservation:${reservation.id}:settle`, "release", reservation.taskId, 1, -1, 0);
  }
  const next = { ...account, available: account.available + expired.length, reserved: account.reserved - expired.length };
  await tx.update(creditAccounts).set({ available: next.available, reserved: next.reserved }).where(accountWhere(account.userId, account));
  return next;
}
export class MySqlPaymentsRepository implements PaymentsRepository {
  constructor(private readonly scope: AccountScope, private readonly now: () => Date = () => new Date()) {}
  async createOrder(input: NewPaymentOrder) {
    const db = await database();
    return db.transaction(async tx => {
      await lockAccount(tx, input.userId, this.scope);
      const existing = (await tx.select().from(paymentOrders).where(and(eq(paymentOrders.userId, input.userId), eq(paymentOrders.environment, input.environment), eq(paymentOrders.appId, input.appId), eq(paymentOrders.requestId, input.requestId))).limit(1))[0];
      if (existing) {
        if (existing.packageId !== input.package.id || existing.environment !== input.environment
          || existing.appId !== input.appId || existing.sellerId !== input.sellerId) {
          throw new TRPCError({ code: "CONFLICT", message: "该请求标识已用于另一笔订单。" });
        }
        return existing;
      }
      const pending = await tx.select({ id: paymentOrders.id }).from(paymentOrders).where(and(eq(paymentOrders.userId, input.userId), eq(paymentOrders.environment, input.environment), eq(paymentOrders.appId, input.appId), eq(paymentOrders.status, "pending"), gt(paymentOrders.expiresAt, this.now()))).limit(20);
      if (pending.length >= 20) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "待处理订单过多，请先确认已有订单状态。" });
      const recent = await tx.select({ id: paymentOrders.id }).from(paymentOrders).where(and(eq(paymentOrders.userId, input.userId), gt(paymentOrders.createdAt, new Date(this.now().getTime() - 86_400_000)))).limit(100);
      if (recent.length >= 100) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "今日订单请求过多，请稍后再试。" });
      await tx.insert(paymentOrders).values({ id: input.id, userId: input.userId, requestId: input.requestId,
        packageId: input.package.id, packageName: input.package.name, credits: input.package.credits,
        amountFen: input.package.amountFen, currency: "CNY", environment: input.environment,
        appId: input.appId, sellerId: input.sellerId, expiresAt: input.expiresAt });
      return (await tx.select().from(paymentOrders).where(eq(paymentOrders.id, input.id)).limit(1))[0];
    });
  }
  async findOrder(orderId: string) {
    const db = await database();
    return (await db.select().from(paymentOrders).where(eq(paymentOrders.id, orderId)).limit(1))[0] ?? null;
  }
  async applyTrade(orderId: string, evidence: PaymentEvidence, notification?: NotificationEvent) {
    const db = await database();
    const reference = await this.findOrder(orderId);
    if (!reference) throw new TRPCError({ code: "NOT_FOUND", message: "订单不存在。" });
    await db.transaction(async tx => {
      const account = await lockAccount(tx, reference.userId, reference);
      const order = (await tx.select().from(paymentOrders).where(eq(paymentOrders.id, orderId)).limit(1).for("update"))[0];
      if (!order || order.environment !== evidence.environment || order.appId !== evidence.appId
        || order.sellerId !== evidence.sellerId || order.amountFen !== evidence.amountFen
        || !/^[A-Za-z0-9_-]{1,64}$/.test(evidence.tradeNo) || order.tradeNo && order.tradeNo !== evidence.tradeNo) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "支付结果无法确认。" });
      }
      if (notification) {
        const prior = (await tx.select().from(paymentNotifications).where(eq(paymentNotifications.eventKey, notification.eventKey)).limit(1))[0];
        if (prior) {
          if (prior.orderId !== order.id || prior.payloadHash !== notification.payloadHash) throw new Error("Conflicting payment notification.");
          return;
        }
      }
      const paid = evidence.status === "TRADE_SUCCESS" || evidence.status === "TRADE_FINISHED";
      if (paid && order.status !== "paid") {
        if (order.status === "closed" || account.available + account.reserved + account.consumed + order.credits > maxAccountCount) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "支付结果需要人工核对。" });
        }
        await tx.update(paymentOrders).set({ status: "paid", tradeNo: evidence.tradeNo, paidAt: this.now() }).where(eq(paymentOrders.id, order.id));
        await tx.update(creditAccounts).set({ available: account.available + order.credits }).where(accountWhere(order.userId, order));
        await ledger(tx, order.userId, order, `order:${order.id}:purchase`, "purchase", order.id, order.credits, 0, 0);
      } else if (!paid && order.status === "pending" && evidence.status === "TRADE_CLOSED") {
        await tx.update(paymentOrders).set({ status: "closed", tradeNo: evidence.tradeNo }).where(eq(paymentOrders.id, order.id));
      }
      if (notification) await tx.insert(paymentNotifications).values({ ...notification, orderId: order.id, status: evidence.status });
    });
  }
  async balance(userId: number) {
    const db = await database();
    return db.transaction(async tx => balanceOf(await releaseExpired(tx, await lockAccount(tx, userId, this.scope), this.now())));
  }
  async reserve(userId: number, taskId: string, requestHash: string) {
    const db = await database();
    return db.transaction(async tx => {
      const now = this.now();
      const account = await releaseExpired(tx, await lockAccount(tx, userId, this.scope), now);
      const prior = (await tx.select().from(generationCreditReservations).where(and(reservationWhere(userId, this.scope), eq(generationCreditReservations.taskId, taskId))).limit(1))[0];
      // A replay must never start a second paid generation, even after a release.
      if (prior) throw new TRPCError({ code: "CONFLICT", message: "该创作任务已提交，请使用新的任务标识。" });
      if (account.available < 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "免费额度已用完，购买创作次数后可继续。" });
      const id = randomUUID(); const expiresAt = new Date(now.getTime() + reservationLifetimeMs);
      await tx.insert(generationCreditReservations).values({ id, userId, ...this.scope, taskId, requestHash, state: "reserved", expiresAt });
      await tx.update(creditAccounts).set({ available: account.available - 1, reserved: account.reserved + 1 }).where(accountWhere(userId, this.scope));
      await ledger(tx, userId, this.scope, `reservation:${id}:reserve`, "reserve", taskId, -1, 1, 0);
      return { taskId, expiresAt: expiresAt.toISOString() };
    });
  }
  async settle(userId: number, taskId: string, outcome: GenerationCreditOutcome, options: { signal?: AbortSignal } = {}) {
    const signal = outcome === "success" ? options.signal : undefined;
    signal?.throwIfAborted();
    const db = await database();
    return db.transaction(async tx => {
      signal?.throwIfAborted();
      const account = await lockAccount(tx, userId, this.scope); const now = this.now();
      signal?.throwIfAborted();
      const reservation = (await tx.select().from(generationCreditReservations).where(and(reservationWhere(userId, this.scope), eq(generationCreditReservations.taskId, taskId))).limit(1).for("update"))[0];
      if (!reservation) throw new TRPCError({ code: "NOT_FOUND", message: "创作额度预占不存在。" });
      if (reservation.state !== "reserved") {
        if (reservation.outcome === outcome || reservation.state === "released" && outcome !== "success") return balanceOf(account);
        throw new TRPCError({ code: "CONFLICT", message: "该任务已结算，请勿重复执行。" });
      }
      if (outcome === "success" && reservation.expiresAt <= now) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "任务额度预占已过期，请重新提交。" });
      }
      if (account.reserved < 1) throw new Error("Credit account requires reconciliation.");
      const consumed = outcome === "success";
      const next = { available: account.available + (consumed ? 0 : 1), reserved: account.reserved - 1, consumed: account.consumed + (consumed ? 1 : 0) };
      await tx.update(generationCreditReservations).set({ state: consumed ? "consumed" : "released", outcome, settledAt: now }).where(eq(generationCreditReservations.id, reservation.id));
      await tx.update(creditAccounts).set(next).where(accountWhere(userId, this.scope));
      await ledger(tx, userId, this.scope, `reservation:${reservation.id}:settle`, consumed ? "consume" : "release", taskId, consumed ? 0 : 1, -1, consumed ? 1 : 0);
      // An abort while waiting for account/ledger writes must roll back the debit.
      signal?.throwIfAborted();
      return next;
    });
  }
}
