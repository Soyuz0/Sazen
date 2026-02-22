import { describe, expect, it } from "vitest";
import { computeNetworkIdleBudgetMs } from "../src/session.js";

describe("session timing helpers", () => {
  it("caps network idle budget at 2s", () => {
    expect(computeNetworkIdleBudgetMs(20_000, 120)).toBe(2_000);
  });

  it("respects quiet window minimum", () => {
    expect(computeNetworkIdleBudgetMs(2_000, 900)).toBe(900);
  });

  it("never goes below 400ms floor", () => {
    expect(computeNetworkIdleBudgetMs(300, 10)).toBe(400);
  });
});
