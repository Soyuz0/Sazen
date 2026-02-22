import { describe, expect, it } from "vitest";
import { AgentSession, computeNetworkIdleBudgetMs, computeQuietWindowMs } from "../src/session.js";

describe("session timing helpers", () => {
  it("uses smaller budgets in fast profile", () => {
    expect(computeNetworkIdleBudgetMs("fast", 20_000, 120, "click")).toBeLessThan(
      computeNetworkIdleBudgetMs("balanced", 20_000, 120, "click")
    );
  });

  it("uses larger budgets in chatty profile", () => {
    expect(computeNetworkIdleBudgetMs("chatty", 10_000, 220, "navigate")).toBeGreaterThan(
      computeNetworkIdleBudgetMs("balanced", 10_000, 220, "navigate")
    );
  });

  it("respects quiet window floor", () => {
    expect(computeNetworkIdleBudgetMs("balanced", 2_000, 900, "click")).toBeGreaterThanOrEqual(900);
  });

  it("computes profile-specific quiet windows", () => {
    expect(computeQuietWindowMs("fast", 120)).toBeLessThan(120);
    expect(computeQuietWindowMs("chatty", 120)).toBeGreaterThan(120);
  });

  it("tracks execution pause sources and elapsed time", async () => {
    const session = new AgentSession({ captureScreenshots: false });

    const initial = session.pauseExecution("overlay");
    expect(initial.paused).toBe(true);
    expect(initial.sources).toEqual(["overlay"]);

    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 30);
    });

    const withSecondSource = session.pauseExecution("adapter");
    expect(withSecondSource.sources).toEqual(["adapter", "overlay"]);

    const partiallyResumed = await session.resumeExecution("overlay");
    expect(partiallyResumed.paused).toBe(true);
    expect(partiallyResumed.sources).toEqual(["adapter"]);

    const resumed = await session.resumeExecution("adapter");
    expect(resumed.paused).toBe(false);
    expect(resumed.pausedMs).toBeGreaterThan(0);
    expect(resumed.sources).toEqual([]);
  });
});
