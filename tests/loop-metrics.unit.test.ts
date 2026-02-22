import { describe, expect, it } from "vitest";
import { buildLoopMetricsReport } from "../src/loop.js";
import type { LoopRunReport } from "../src/types.js";

describe("loop metrics", () => {
  it("builds iteration and branch KPI summaries", () => {
    const report = {
      maxIterations: 10,
      stopReason: "branch_break",
      iterations: [
        {
          iteration: 1,
          stepResult: { durationMs: 100 },
          selectedBranchLabel: "continue",
          selectedBranchActionResults: [{ durationMs: 20 }]
        },
        {
          iteration: 2,
          stepResult: { durationMs: 300 },
          selectedBranchLabel: "continue",
          selectedBranchActionResults: [{ durationMs: 40 }, { durationMs: 10 }]
        },
        {
          iteration: 3,
          stepResult: { durationMs: 200 },
          selectedBranchLabel: "done",
          selectedBranchActionResults: []
        }
      ]
    } as unknown as LoopRunReport;

    const metrics = buildLoopMetricsReport(report);
    expect(metrics.iterationCount).toBe(3);
    expect(metrics.stopReason).toBe("branch_break");
    expect(metrics.durationsMs.step.p50).toBe(200);
    expect(metrics.durationsMs.step.p95).toBe(300);
    expect(metrics.branchSelection.continue).toBe(2);
    expect(metrics.branchSelection.done).toBe(1);
    expect(metrics.selectedBranchTransitions.some((item) => item.from === "continue" && item.to === "done")).toBe(
      true
    );
  });
});
