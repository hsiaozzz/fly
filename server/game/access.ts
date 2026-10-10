import { TRPCError } from "@trpc/server";
import type { Request } from "express";

type Counter = { day: number; calls: number; active: number; tokens: number };
const actors = new Map<string, Counter>();
const globalCounter: Counter = { day: 0, calls: 0, active: 0, tokens: 0 };
let draining = false;
const setting = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
};
const tokenReservation = () => {
  const value = Number(process.env.GENERATION_TOKEN_RESERVE);
  // Unlike admission caps, zero must not disable the per-job budget reservation.
  return Number.isSafeInteger(value) && value > 0 ? value : 64_000;
};
function refresh(counter: Counter, day: number) {
  if (counter.day !== day) { counter.day = day; counter.calls = 0; counter.tokens = 0; }
}
function deny(message: string): never { throw new TRPCError({ code: "TOO_MANY_REQUESTS", message }); }

/** Only this product allowance may be replaced by a purchased credit. */
export class GenerationAllowanceError extends TRPCError {
  constructor() { super({ code: "TOO_MANY_REQUESTS", message: "Daily generation allowance reached." }); }
}

/** Single-process safety caps shared by every generation entry point. A multi-
 * replica deployment needs a shared atomic limiter before increasing replicas. */
export function acquireGenerationLease(req: Request, user?: { id: number } | null, options: { paidCredit?: boolean } = {}) {
  if (draining) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Server is shutting down." });
  const day = Math.floor(Date.now() / 86_400_000);
  const authenticated = Boolean(user && user.id > 0);
  const key = authenticated ? `user:${user!.id}` : `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;
  if (!actors.has(key) && actors.size >= 10_000) {
    for (const [actor, counter] of actors) if (counter.day !== day && counter.active === 0) actors.delete(actor);
    if (actors.size >= 10_000) deny("Generation capacity is temporarily full.");
  }
  const counter = actors.get(key) ?? { day, calls: 0, active: 0, tokens: 0 };
  actors.set(key, counter); refresh(counter, day); refresh(globalCounter, day);
  const reserve = tokenReservation();
  const dailyCalls = setting(authenticated ? "GENERATION_USER_DAILY_LIMIT" : "GENERATION_ANON_DAILY_LIMIT", authenticated ? 30 : 3);
  const concurrency = setting(authenticated ? "GENERATION_USER_CONCURRENCY" : "GENERATION_ANON_CONCURRENCY", authenticated ? 2 : 1);
  if (counter.active >= concurrency) deny("Another generation is already running.");
  if (globalCounter.active >= setting("GENERATION_GLOBAL_CONCURRENCY", 4)) deny("Generation capacity is temporarily full.");
  if (globalCounter.calls >= setting("GENERATION_GLOBAL_DAILY_LIMIT", 200)
    || globalCounter.tokens + reserve > setting("GENERATION_GLOBAL_DAILY_TOKENS", 2_000_000)) deny("Server generation budget reached. Try again tomorrow.");
  if (counter.calls >= dailyCalls && !(authenticated && options.paidCredit)) {
    if (authenticated) throw new GenerationAllowanceError();
    deny("Anonymous allowance reached. Sign in to continue.");
  }
  counter.calls++; counter.active++; counter.tokens += reserve;
  globalCounter.calls++; globalCounter.active++; globalCounter.tokens += reserve;
  let released = false;
  let charged = reserve;
  return {
    /** Cumulative provider usage. Missing usage retains the reservation. */
    recordUsage(tokens?: number) {
      if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0 || released || counter.day !== day) return;
      const next = Math.max(charged, Math.ceil(tokens));
      counter.tokens += next - charged;
      if (globalCounter.day === day) globalCounter.tokens += next - charged;
      charged = next;
    },
    release() {
      if (released) return;
      released = true; counter.active = Math.max(0, counter.active - 1); globalCounter.active = Math.max(0, globalCounter.active - 1);
    },
  };
}
export function generationCapacity() { return { active: globalCounter.active, draining }; }
export function stopGenerationAdmission() { draining = true; }
export function resetGenerationLimitsForTests() { actors.clear(); Object.assign(globalCounter, { day: 0, calls: 0, active: 0, tokens: 0 }); draining = false; }
