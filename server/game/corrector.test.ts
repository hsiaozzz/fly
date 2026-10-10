import { describe, expect, it } from "vitest";
import { correctGameSpec, describeStop, MAX_ATTEMPTS } from "../../shared/game/corrector";
import { runGates } from "../../shared/game/gates";
import { normalizeGameSpec } from "../../shared/game/gamespec";
import type { GameSpec } from "../../shared/game/types";

/** A spec that passes every gate: the maintained flappy defaults. */
function healthy(): GameSpec {
  return normalizeGameSpec({ game: { genre: "flappy" } });
}

/** Break one thing on an otherwise healthy spec. */
function broken(patch: (spec: GameSpec) => void): GameSpec {
  const spec = healthy();
  patch(spec);
  return spec;
}

describe("semantic gates", () => {
  it("passes the maintained flappy defaults", () => {
    const report = runGates(healthy());
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("rejects a flappy bird that can never fall", () => {
    const report = runGates(broken(spec => { spec.config.gravity = 0; }));
    expect(report.failures.some(item => item.includes("gravity"))).toBe(true);
  });

  it("rejects a shooter with no verb", () => {
    const spec = normalizeGameSpec({ game: { genre: "shooter" } });
    spec.mechanics = ["movement"];
    const report = runGates(spec);
    expect(report.failures.some(item => item.includes("shoot"))).toBe(true);
  });

  it("rejects a spec with no player entity", () => {
    const report = runGates(broken(spec => { spec.entities = [{ id: "pipe", type: "obstacle" }]; }));
    expect(report.failures.some(item => item.includes("player"))).toBe(true);
  });

  it("rejects a gap the player cannot fit through", () => {
    const report = runGates(broken(spec => { spec.config.obstacleGap = 60; }));
    expect(report.failures.some(item => item.includes("narrower"))).toBe(true);
  });

  it("rejects obstacles spaced closer than the gap inside them", () => {
    const report = runGates(broken(spec => {
      spec.config.playerSpeed = 900;
      spec.config.obstacleInterval = 500;
      spec.config.obstacleGap = 600;
    }));
    expect(report.failures.some(item => item.includes("apart at"))).toBe(true);
  });

  it("reports every defect, not just the first", () => {
    const spec = healthy();
    spec.config.gravity = 0;
    spec.entities = [];
    const report = runGates(spec);
    expect(report.failures.length).toBeGreaterThan(1);
  });
});

describe("bounded correction", () => {
  it("stops with not_attempted when no reviser is supplied", async () => {
    const outcome = await correctGameSpec(broken(spec => { spec.config.gravity = 0; }));
    expect(outcome.ok).toBe(false);
    expect(outcome.stopReason).toBe("not_attempted");
    expect(outcome.attempts).toBe(0);
  });

  it("returns passed when the reviser fixes everything", async () => {
    const outcome = await correctGameSpec(
      broken(spec => { spec.config.gravity = 0; }),
      async () => healthy(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.stopReason).toBe("passed");
    expect(outcome.attempts).toBe(1);
  });

  it("stops as repeating when the same defect set comes back", async () => {
    const outcome = await correctGameSpec(
      broken(spec => { spec.config.gravity = 0; }),
      async spec => spec, // reviser changes nothing
    );
    expect(outcome.stopReason).toBe("repeating");
    // The second attempt never happened: re-prompting could not have helped.
    expect(outcome.attempts).toBe(1);
  });

  it("stops as revise_failed and reports the reviser's error", async () => {
    const outcome = await correctGameSpec(
      broken(spec => { spec.config.gravity = 0; }),
      async () => { throw new Error("model unavailable"); },
    );
    expect(outcome.stopReason).toBe("revise_failed");
    expect(outcome.detail).toContain("model unavailable");
  });

  it("stops as no_progress when defects change but do not shrink", async () => {
    const outcome = await correctGameSpec(
      broken(spec => {
        spec.config.gravity = 0;
        spec.entities = [];
      }),
      async spec => {
        // Swap two defects for two different ones.
        const next = healthy();
        next.config.gravity = spec.config.gravity === 0 ? 0 : 980;
        next.config.obstacleGap = 60;
        return next;
      },
    );
    expect(outcome.stopReason).toBe("no_progress");
  });

  it("stops as oscillating when an earlier defect set returns", async () => {
    let call = 0;
    const outcome = await correctGameSpec(
      broken(spec => {
        spec.config.gravity = 0;
        spec.config.obstacleGap = 60; // two defects
      }),
      async () => {
        call += 1;
        // First revision drops one defect; the second puts both back.
        return call === 1
          ? broken(spec => { spec.config.gravity = 0; })
          : broken(spec => { spec.config.gravity = 0; spec.config.obstacleGap = 60; });
      },
    );
    expect(outcome.stopReason).toBe("oscillating");
  });

  it("stops as exhausted and returns the best spec seen, not the last one", async () => {
    let call = 0;
    const outcome = await correctGameSpec(
      broken(spec => {
        spec.config.gravity = 0;
        spec.config.obstacleGap = 60;
      }),
      async () => {
        call += 1;
        return broken(spec => { spec.config.gravity = 0; });
      },
      { maxAttempts: 1 },
    );
    expect(outcome.stopReason).toBe("exhausted");
    expect(call).toBe(1);
    // Best is the one-defect revision, not the two-defect original.
    expect(runGates(outcome.spec).failures.length).toBe(1);
  });

  it("never exceeds the attempt budget", async () => {
    let calls = 0;
    await correctGameSpec(
      broken(spec => { spec.config.gravity = 0; }),
      async spec => {
        calls += 1;
        // Improve slightly but never fully, to drive the loop to its budget.
        return { ...spec, config: { ...spec.config, obstacleGap: 140 + calls } };
      },
    );
    expect(calls).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });

  it("describes each stop reason in one readable line", async () => {
    const outcome = await correctGameSpec(broken(spec => { spec.config.gravity = 0; }));
    expect(describeStop(outcome)).toContain("defect");
    const passed = await correctGameSpec(healthy(), async spec => spec);
    expect(describeStop(passed)).toContain("passed");
  });
});
