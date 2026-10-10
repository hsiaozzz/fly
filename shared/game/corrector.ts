import { runGates, type GateReport } from "./gates";
import type { GameSpec } from "./types";

/**
 * Bounded correction loop for GameSpec.
 *
 * Ported from `operators/gen_3d_object/funcs/code_asset.py` (GameFactory-3A),
 * whose docstring records the failure this shape exists to prevent:
 *
 *   "An unbounded loop in img2threejs spent 45 minutes recording a car that
 *    never moved: a lookup returned None, the loop optimised a metric that
 *    could not see it, and nothing raised."
 *
 * The same failure is available here. A loop that re-prompts an LLM until the
 * spec looks right will happily re-prompt forever on a spec that cannot be
 * fixed by re-prompting — burning tokens and latency to return the same
 * defect list. So this stops on **all four ways a loop fails to converge**,
 * and `stopReason` says which one happened, because the response to each is
 * different: revise harder, revise differently, or stop and report that the
 * spec itself is wrong.
 */

export type StopReason =
  /** Every gate is green. */
  | "passed"
  /** The attempt budget ran out. */
  | "exhausted"
  /** The identical defect set came back: the last revision addressed none of it. */
  | "repeating"
  /** A defect set from an earlier attempt returned: defects are being traded. */
  | "oscillating"
  /** Different defects, but no fewer of them. */
  | "no_progress"
  /** The reviser threw. Reported, never swallowed. */
  | "revise_failed"
  /** No reviser was supplied, so nothing was attempted. */
  | "not_attempted";

export type CorrectionOutcome = {
  ok: boolean;
  /** The best spec seen — the fewest defects, not necessarily the last one. */
  spec: GameSpec;
  attempts: number;
  stopReason: StopReason;
  detail?: string;
  gates: GateReport;
};

/**
 * Three, matching GameFactory-3A, and for its reason: a defect that survives
 * three targeted corrections is not being understood, and a fourth attempt is
 * the same attempt.
 */
export const MAX_ATTEMPTS = 3;

/** A defect list, reduced to something comparable across attempts. */
function fingerprint(failures: string[]): string[] {
  return [...failures].sort();
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Generic bounded correction loop.
 *
 * `correctGameSpec` is a thin wrapper over this. It exists so the convergence
 * logic — the six stop reasons — is written once. The free-form generator
 * corrects an artifact file tree rather than a spec, and a second copy of this
 * loop would eventually disagree with the first about when to give up.
 */
export type CorrectionResult<T> = {
  ok: boolean;
  /** The best candidate seen — the fewest defects, not necessarily the last one. */
  candidate: T;
  attempts: number;
  stopReason: StopReason;
  detail?: string;
  defects: string[];
};

export async function correctWith<T>(options: {
  initial: T;
  defects: (candidate: T) => string[];
  revise?: (candidate: T, defects: string[]) => Promise<T>;
  maxAttempts?: number;
}): Promise<CorrectionResult<T>> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;

  let current = options.initial;
  let attempts = 0;
  const history: string[][] = [];
  let best: CorrectionResult<T> = {
    ok: false,
    candidate: current,
    attempts,
    stopReason: "not_attempted",
    defects: options.defects(current),
  };

  const stop = (stopReason: StopReason, detail?: string): CorrectionResult<T> => ({
    ok: false,
    candidate: best.candidate,
    attempts,
    stopReason,
    ...(detail ? { detail } : {}),
    defects: best.defects,
  });

  while (true) {
    const defects = fingerprint(options.defects(current));

    if (defects.length < best.defects.length) {
      best = { ok: false, candidate: current, attempts, stopReason: "not_attempted", defects };
    }

    if (defects.length === 0) {
      return { ok: true, candidate: current, attempts, stopReason: "passed", defects };
    }

    // Only judge convergence once there is a previous attempt to compare
    // against — measuring the first pass against nothing is how a loop stops
    // before it starts.
    if (history.length) {
      if (sameSet(defects, history[history.length - 1]!)) {
        return stop(
          "repeating",
          "the identical defect set came back, so the last revision addressed none of it",
        );
      }
      if (history.some(previous => sameSet(defects, previous))) {
        return stop(
          "oscillating",
          "a defect set from an earlier attempt has returned: defects are being traded for one another",
        );
      }
      if (defects.length >= history[history.length - 1]!.length) {
        return stop(
          "no_progress",
          `${defects.length} defect(s) after attempt ${attempts}, no fewer than the ${history[history.length - 1]!.length} before it`,
        );
      }
    }

    history.push(defects);

    if (attempts >= maxAttempts) {
      return stop(
        "exhausted",
        `${best.defects.length} defect(s) left after ${maxAttempts} attempt(s)`,
      );
    }

    if (!options.revise) {
      return stop("not_attempted", "gates failed and no reviser was supplied");
    }

    attempts += 1;
    try {
      current = await options.revise(current, options.defects(current));
    } catch (error) {
      // A reviser that cannot produce a candidate is the loud version of the
      // silent early return. Report it; do not fall through to "valid".
      return stop("revise_failed", `${error instanceof Error ? error.name : "Error"}: ${String(error instanceof Error ? error.message : error)}`);
    }
  }
}

export async function correctGameSpec(
  spec: GameSpec,
  revise?: (spec: GameSpec, failures: string[]) => Promise<GameSpec>,
  options: { maxAttempts?: number } = {},
): Promise<CorrectionOutcome> {
  const result = await correctWith<GameSpec>({
    initial: spec,
    defects: candidate => runGates(candidate).failures,
    revise,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });
  return {
    ok: result.ok,
    spec: result.candidate,
    attempts: result.attempts,
    stopReason: result.stopReason,
    ...(result.detail ? { detail: result.detail } : {}),
    gates: runGates(result.candidate),
  };
}

/** Human-readable one-liner for traces and logs. */
export function describeStop(outcome: CorrectionOutcome): string {
  const { stopReason, attempts, gates } = outcome;
  const count = gates.failures.length;
  switch (stopReason) {
    case "passed":
      return attempts
        ? `Semantic gates passed after ${attempts} revision(s).`
        : "Semantic gates passed on the first try.";
    case "exhausted":
      return `Gave up after ${attempts} revision(s); ${count} defect(s) remain.`;
    case "repeating":
      return `Stopped: the same ${count} defect(s) returned unchanged, so re-prompting cannot fix them.`;
    case "oscillating":
      return `Stopped: revisions are trading one defect for another across ${attempts} attempt(s).`;
    case "no_progress":
      return `Stopped: ${count} defect(s) remain, no fewer than before attempt ${attempts}.`;
    case "revise_failed":
      return `Stopped: the reviser failed; ${count} defect(s) unresolved.`;
    default:
      return `${count} defect(s) found; no revision attempted.`;
  }
}
