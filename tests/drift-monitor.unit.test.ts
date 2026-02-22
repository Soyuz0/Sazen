import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendMatrixSummaryToDriftHistory,
  buildDriftRecommendationReport
} from "../src/drift-monitor.js";

describe("drift monitor", () => {
  it("aggregates recurring failure signatures across matrix runs", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-drift-monitor-"));
    const historyPath = join(tempDir, "history.json");
    const aggregatePath = join(tempDir, "aggregate.json");

    try {
      const selectorHealthPath = join(tempDir, "selector-health-a.json");
      await writeFile(
        selectorHealthPath,
        JSON.stringify(
          {
            totals: {
              failures: 2,
              timeoutFailures: 1
            },
            topTargets: [
              {
                target: "roleName:button:Search",
                failures: 2,
                timeouts: 1
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const run1Path = join(tempDir, "matrix-run-1.json");
      await writeFile(
        run1Path,
        JSON.stringify(
          {
            createdAt: "2026-02-22T10:00:00.000Z",
            totalSites: 2,
            failedSites: 1,
            sites: [
              {
                site: "site-a",
                status: "failed",
                failedActions: 1,
                timedOut: false,
                durationMs: 1200,
                tracePath: "/tmp/trace-a-1.json",
                selectorHealthPath
              },
              {
                site: "site-b",
                status: "ok",
                failedActions: 0,
                timedOut: false,
                durationMs: 900,
                tracePath: "/tmp/trace-b-1.json"
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const run2Path = join(tempDir, "matrix-run-2.json");
      await writeFile(
        run2Path,
        JSON.stringify(
          {
            createdAt: "2026-02-22T11:00:00.000Z",
            totalSites: 2,
            failedSites: 1,
            sites: [
              {
                site: "site-a",
                status: "failed",
                failedActions: 1,
                timedOut: false,
                durationMs: 1300,
                tracePath: "/tmp/trace-a-2.json",
                selectorHealthPath
              },
              {
                site: "site-b",
                status: "ok",
                failedActions: 0,
                timedOut: false,
                durationMs: 850,
                tracePath: "/tmp/trace-b-2.json"
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      await appendMatrixSummaryToDriftHistory({
        matrixSummaryPath: run1Path,
        historyPath,
        aggregatePath
      });

      const second = await appendMatrixSummaryToDriftHistory({
        matrixSummaryPath: run2Path,
        historyPath,
        aggregatePath
      });

      expect(second.history.runs).toHaveLength(2);
      expect(second.aggregate.totalRuns).toBe(2);
      expect(second.aggregate.runsWithFailures).toBe(2);

      const topFailure = second.aggregate.recurringFailures[0];
      expect(topFailure).toBeDefined();
      expect(topFailure.occurrences).toBe(2);
      expect(topFailure.sites).toContain("site-a");

      const siteA = second.aggregate.siteFailureRates.find((entry) => entry.site === "site-a");
      const siteB = second.aggregate.siteFailureRates.find((entry) => entry.site === "site-b");
      expect(siteA?.failureRate).toBe(1);
      expect(siteB?.failureRate).toBe(0);

      const recommendations = buildDriftRecommendationReport({
        aggregate: second.aggregate,
        minOccurrences: 2,
        top: 5
      });
      expect(recommendations.totalRecommendations).toBeGreaterThan(0);
      expect(recommendations.recommendations[0]?.priority).toBe("high");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
