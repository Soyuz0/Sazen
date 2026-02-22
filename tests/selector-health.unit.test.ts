import { describe, expect, it } from "vitest";
import { buildSelectorHealthReport } from "../src/selector-health.js";
import type { SavedTrace } from "../src/types.js";

describe("selector health", () => {
  it("builds fallback, ambiguity, and timeout metrics", () => {
    const trace: SavedTrace = {
      version: 2,
      createdAt: new Date().toISOString(),
      sessionId: "selector-health",
      options: {},
      records: [
        {
          action: {
            type: "click",
            target: {
              kind: "css",
              selector: "#primary"
            }
          },
          result: {
            status: "ok",
            postDomHash: "h1",
            durationMs: 100,
            selectorTarget: "css:#primary",
            selectorCandidateCount: 1,
            selectorFallbackDepth: 0,
            selectorAttemptedCount: 1,
            selectorSelectedCandidate: "css:#primary"
          }
        },
        {
          action: {
            type: "fill",
            value: "hello",
            target: {
              kind: "css",
              selector: "#primary"
            }
          },
          result: {
            status: "ok",
            postDomHash: "h2",
            durationMs: 120,
            selectorTarget: "css:#primary",
            selectorCandidateCount: 3,
            selectorFallbackDepth: 2,
            selectorAttemptedCount: 3,
            selectorSelectedCandidate: "path:/html/body/input"
          }
        },
        {
          action: {
            type: "click",
            target: {
              kind: "css",
              selector: "#danger"
            }
          },
          result: {
            status: "fatal_error",
            postDomHash: "h3",
            durationMs: 90,
            selectorTarget: "css:#danger",
            selectorCandidateCount: 2,
            errorMessage: "Timeout 5000ms exceeded"
          }
        },
        {
          action: {
            type: "assert",
            condition: {
              kind: "selector",
              selector: "#status",
              state: "visible"
            }
          },
          result: {
            status: "ok",
            postDomHash: "h4",
            durationMs: 40,
            selectorTarget: "assert:#status"
          }
        }
      ]
    };

    const report = buildSelectorHealthReport(trace, "/tmp/trace.json");
    expect(report.totals.selectorActions).toBe(4);
    expect(report.totals.fallbackUsed).toBe(1);
    expect(report.totals.ambiguous).toBe(2);
    expect(report.totals.failures).toBe(1);
    expect(report.totals.timeoutFailures).toBe(1);
    expect(report.fallbackDepth.average).toBe(1);
    expect(report.fallbackDepth.max).toBe(2);
    expect(report.fallbackDepth.histogram["0"]).toBe(1);
    expect(report.fallbackDepth.histogram["2"]).toBe(1);
    expect(report.topTargets.some((entry) => entry.target === "css:#primary" && entry.total === 2)).toBe(true);
  });
});
