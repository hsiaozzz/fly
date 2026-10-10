import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { creditAccounts, creditLedger, generationCreditReservations, paymentNotifications, paymentOrders, users } from "../../drizzle/schema";
import { MySqlPaymentsRepository, type PaymentEvidence, type StoredPaymentOrder } from "./repository";

// Only CI's explicitly supplied disposable database. No deployed DATABASE_URL
// is accessed when this suite is skipped; all gateway evidence is local mock data.
describe.runIf(Boolean(process.env.ARCANE_TEST_DATABASE_URL))("MySQL payment/credit transactions (mock gateway)", () => {
  let database: typeof import("../db");
  let db: NonNullable<Awaited<ReturnType<typeof import("../db").getDb>>>;
  let userId: number;
  const scope = { environment: "sandbox" as const, appId: "2026000000000001" };
  let now: Date; let repository: MySqlPaymentsRepository;
  async function clearFixtures() {
    if (!db || !userId) return;
    const orders = await db.select({ id: paymentOrders.id }).from(paymentOrders).where(eq(paymentOrders.userId, userId));
    for (const order of orders) await db.delete(paymentNotifications).where(eq(paymentNotifications.orderId, order.id));
    await db.delete(generationCreditReservations).where(eq(generationCreditReservations.userId, userId));
    await db.delete(creditLedger).where(eq(creditLedger.userId, userId));
    await db.delete(paymentOrders).where(eq(paymentOrders.userId, userId));
    await db.delete(creditAccounts).where(eq(creditAccounts.userId, userId));
  }
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", process.env.ARCANE_TEST_DATABASE_URL!);
    database = await import("../db"); db = (await database.getDb())!;
    await database.checkDatabaseReadiness();
    const openId = `payment-ci-${randomUUID()}`;
    await database.upsertUser({ openId }); userId = (await database.getUserByOpenId(openId))!.id;
  });
  beforeEach(async () => {
    await clearFixtures(); now = new Date(); repository = new MySqlPaymentsRepository(scope, () => now);
  });
  afterAll(async () => {
    try { await clearFixtures(); if (db && userId) await db.delete(users).where(eq(users.id, userId)); }
    finally { await database?.closeDb(); vi.unstubAllEnvs(); }
  });
  async function order(credits = 1, owner = repository, requestId = randomUUID()) {
    return owner.createOrder({ id: randomUUID().replaceAll("-", ""), userId, requestId,
      package: { id: "fixture", name: "CI mock package", credits, amountFen: 100, currency: "CNY" },
      ...scope, sellerId: "2088000000000001", expiresAt: new Date(now.getTime() + 1_800_000) });
  }
  function evidence(row: StoredPaymentOrder, tradeNo = `test_${randomUUID().replaceAll("-", "")}`): PaymentEvidence {
    return { environment: row.environment, appId: row.appId, sellerId: row.sellerId,
      amountFen: row.amountFen, tradeNo, status: "TRADE_SUCCESS" };
  }
  async function purchased(credits = 1) { const row = await order(credits); await repository.applyTrade(row.id, evidence(row)); return row; }
  it("commits concurrent notification/query confirmation exactly once and survives a new repository", async () => {
    const row = await order(10); const paid = evidence(row);
    const event = { eventKey: createHash("sha256").update(`event:${row.id}`).digest("hex"), payloadHash: "a".repeat(64) };
    const restarted = new MySqlPaymentsRepository(scope);
    await Promise.all([repository.applyTrade(row.id, paid, event), restarted.applyTrade(row.id, paid), repository.applyTrade(row.id, paid, event)]);
    expect(await restarted.balance(userId)).toEqual({ available: 10, reserved: 0, consumed: 0 });
    const purchases = await db.select().from(creditLedger).where(and(eq(creditLedger.userId, userId), eq(creditLedger.kind, "purchase")));
    expect(purchases).toHaveLength(1);
    expect(await db.select().from(paymentNotifications).where(eq(paymentNotifications.orderId, row.id))).toHaveLength(1);
    await expect(repository.applyTrade(row.id, paid, { ...event, payloadHash: "b".repeat(64) })).rejects.toThrow();
    expect(await restarted.balance(userId)).toEqual({ available: 10, reserved: 0, consumed: 0 });
  });
  it("replays one checkout request without allocating another order", async () => {
    const requestId = randomUUID();
    const rows = await Promise.all([order(10, repository, requestId), order(10, repository, requestId)]);
    expect(rows[0].id).toBe(rows[1].id);
    expect(await db.select().from(paymentOrders).where(eq(paymentOrders.userId, userId))).toHaveLength(1);
  });
  it("rolls back the paid state and balance when ledger insertion fails", async () => {
    const row = await order();
    await db.insert(creditLedger).values({ id: randomUUID(), userId, ...scope,
      eventKey: `order:${row.id}:purchase`, kind: "purchase", referenceId: row.id, availableDelta: 0, reservedDelta: 0, consumedDelta: 0 });
    await expect(repository.applyTrade(row.id, evidence(row))).rejects.toThrow();
    expect((await repository.findOrder(row.id))!.status).toBe("pending");
    expect(await repository.balance(userId)).toEqual({ available: 0, reserved: 0, consumed: 0 });
  });
  it("lets only one concurrent generation reserve the final credit and settles/replays once", async () => {
    await purchased(); const taskA = randomUUID(); const taskB = randomUUID();
    const results = await Promise.allSettled([repository.reserve(userId, taskA, "a".repeat(64)), new MySqlPaymentsRepository(scope).reserve(userId, taskB, "b".repeat(64))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const taskId = results[0].status === "fulfilled" ? taskA : taskB;
    expect(await repository.balance(userId)).toEqual({ available: 0, reserved: 1, consumed: 0 });
    expect(await repository.settle(userId, taskId, "success")).toEqual({ available: 0, reserved: 0, consumed: 1 });
    expect(await new MySqlPaymentsRepository(scope).settle(userId, taskId, "success")).toEqual({ available: 0, reserved: 0, consumed: 1 });
    await expect(repository.settle(userId, taskId, "aborted")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.reserve(userId, taskId, "a".repeat(64))).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it.each(["failed", "aborted"] as const)("returns a %s generation reservation exactly once", async outcome => {
    await purchased(); const taskId = randomUUID(); await repository.reserve(userId, taskId, "a".repeat(64));
    expect(await repository.settle(userId, taskId, outcome)).toEqual({ available: 1, reserved: 0, consumed: 0 });
    expect(await repository.settle(userId, taskId, outcome)).toEqual({ available: 1, reserved: 0, consumed: 0 });
    const releases = await db.select().from(creditLedger).where(and(eq(creditLedger.userId, userId), eq(creditLedger.kind, "release")));
    expect(releases).toHaveLength(1);
  });
  it("recovers expired process reservations and never allows the expired task to charge or run twice", async () => {
    await purchased(); const taskId = randomUUID(); await repository.reserve(userId, taskId, "a".repeat(64));
    now = new Date(now.getTime() + 16 * 60_000);
    const restarted = new MySqlPaymentsRepository(scope, () => now);
    expect(await restarted.balance(userId)).toEqual({ available: 1, reserved: 0, consumed: 0 });
    await expect(restarted.settle(userId, taskId, "success")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(restarted.reserve(userId, taskId, "a".repeat(64))).rejects.toMatchObject({ code: "CONFLICT" });
    await restarted.reserve(userId, randomUUID(), "b".repeat(64));
    expect(await restarted.balance(userId)).toEqual({ available: 0, reserved: 1, consumed: 0 });
  });
  it("keeps sandbox, production and another app balances isolated", async () => {
    await purchased(10);
    const production = new MySqlPaymentsRepository({ ...scope, environment: "production" });
    const otherApp = new MySqlPaymentsRepository({ ...scope, appId: "2026000000000002" });
    expect(await production.balance(userId)).toEqual({ available: 0, reserved: 0, consumed: 0 });
    expect(await otherApp.balance(userId)).toEqual({ available: 0, reserved: 0, consumed: 0 });
    await expect(production.reserve(userId, randomUUID(), "a".repeat(64))).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await repository.balance(userId)).toEqual({ available: 10, reserved: 0, consumed: 0 });
  });
  it("rolls back a success cancelled while waiting for the real account row lock", async () => {
    await purchased(); const taskId = randomUUID(); await repository.reserve(userId, taskId, "a".repeat(64));
    const abort = new AbortController();
    let unlock!: () => void; const release = new Promise<void>(resolve => { unlock = resolve; });
    let locked!: (connectionId: number) => void; let lockFailed!: (error: unknown) => void;
    const ready = new Promise<number>((resolve, reject) => { locked = resolve; lockFailed = reject; });
    const holder = db.transaction(async tx => {
      await tx.select().from(creditAccounts).where(and(eq(creditAccounts.userId, userId), eq(creditAccounts.environment, scope.environment), eq(creditAccounts.appId, scope.appId))).for("update");
      const [rows] = await tx.execute(sql`SELECT CONNECTION_ID() AS connectionId`);
      locked(Number((rows as Array<{ connectionId: number }>)[0].connectionId));
      await release;
    });
    void holder.catch(lockFailed);
    const holderConnection = await ready;
    const settlement = repository.settle(userId, taskId, "success", { signal: abort.signal }).then(value => ({ value }), error => ({ error }));
    try {
      const until = Date.now() + 3000; let waiting = false;
      while (Date.now() < until) {
        const [rows] = await db.$client.promise().query(
          "SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID WHERE b.PROCESSLIST_ID = ?", [holderConnection]);
        if (Number((rows as Array<{ n: number }>)[0].n) > 0) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      abort.abort(new DOMException("Test cancelled during database lock wait", "AbortError"));
    } finally { unlock(); await holder; }
    expect(await settlement).toMatchObject({ error: { name: "AbortError" } });
    expect(await repository.balance(userId)).toEqual({ available: 0, reserved: 1, consumed: 0 });
    expect(await db.select().from(creditLedger).where(and(eq(creditLedger.userId, userId), eq(creditLedger.kind, "consume")))).toHaveLength(0);
    expect(await repository.settle(userId, taskId, "aborted")).toEqual({ available: 1, reserved: 0, consumed: 0 });
  });
  it("accepts a delayed paid confirmation after local checkout expiry and ignores out-of-order nonpaid events", async () => {
    const row = await order(10); const paid = evidence(row);
    now = new Date(now.getTime() + 31 * 60_000);
    await repository.applyTrade(row.id, paid);
    await repository.applyTrade(row.id, { ...paid, status: "WAIT_BUYER_PAY" });
    expect((await repository.findOrder(row.id))!.status).toBe("paid");
    expect(await repository.balance(userId)).toEqual({ available: 10, reserved: 0, consumed: 0 });
    await expect(repository.applyTrade(row.id, { ...paid, amountFen: 1 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});
