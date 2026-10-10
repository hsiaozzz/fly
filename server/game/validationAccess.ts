import { TRPCError } from "@trpc/server";

type Counter = { day: number; calls: number; active: number };
const actors = new Map<number, Counter>();
const globalCounter: Counter = { day: 0, calls: 0, active: 0 };
let draining = false;
const setting = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
};
function refresh(counter: Counter, day: number) {
  if (counter.day !== day) { counter.day = day; counter.calls = 0; }
}
function deny(message: string): never { throw new TRPCError({ code: "TOO_MANY_REQUESTS", message }); }

/** CPU/browser admission is independent of LLM calls and token reservations.
 * These safety caps are process-local, like the current generation limiter. */
export function acquireValidationLease(userId: number) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to validate a game." });
  if (draining) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Server is shutting down." });
  const day = Math.floor(Date.now() / 86_400_000);
  if (!actors.has(userId) && actors.size >= 10_000) {
    for (const [actor, counter] of actors) if (counter.day !== day && counter.active === 0) actors.delete(actor);
    if (actors.size >= 10_000) deny("Browser validation capacity is temporarily full.");
  }
  const counter = actors.get(userId) ?? { day, calls: 0, active: 0 };
  actors.set(userId, counter); refresh(counter, day); refresh(globalCounter, day);
  if (counter.calls >= setting("VALIDATION_USER_DAILY_LIMIT", 60)) deny("Daily browser validation allowance reached.");
  if (counter.active >= setting("VALIDATION_USER_CONCURRENCY", 1)) deny("Another browser validation is already running.");
  // The browser worker also has a hard two-job ceiling; configuration may lower
  // it but cannot admit jobs the worker would immediately refuse to execute.
  if (globalCounter.active >= Math.min(setting("VALIDATION_GLOBAL_CONCURRENCY", 2), 2)) deny("Browser validation capacity is temporarily full.");
  if (globalCounter.calls >= setting("VALIDATION_GLOBAL_DAILY_LIMIT", 400)) deny("Server browser validation allowance reached. Try again tomorrow.");
  counter.calls++; counter.active++;
  globalCounter.calls++; globalCounter.active++;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      counter.active = Math.max(0, counter.active - 1);
      globalCounter.active = Math.max(0, globalCounter.active - 1);
    },
  };
}
export function validationCapacity() { return { active: globalCounter.active, draining }; }
export function stopValidationAdmission() { draining = true; }
export function resetValidationLimitsForTests() { actors.clear(); Object.assign(globalCounter, { day: 0, calls: 0, active: 0 }); draining = false; }
