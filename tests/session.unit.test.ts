import { describe, expect, it } from "vitest";
import { computeNetworkIdleBudgetMs, computeQuietWindowMs } from "../src/session.js";

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
});
