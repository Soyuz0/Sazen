import { describe, expect, it } from "vitest";
import { getTraceTimeline } from "../src/trace.js";
import type { SavedTrace } from "../src/types.js";

describe("trace timeline", () => {
  it("uses explicit timeline metadata when present", () => {
    const trace: SavedTrace = {
      version: 2,
      createdAt: new Date().toISOString(),
      sessionId: "timeline",
      options: {},
      timeline: [
        {
          index: 1,
          actionType: "snapshot",
          status: "ok",
          durationMs: 100,
          postUrl: "https://example.com/next",
          postDomHash: "hash2",
          domDiffSummary: { added: 0, removed: 0, changed: 0 },
          eventCount: 1
        },
        {
          index: 0,
          actionType: "navigate",
          status: "ok",
          durationMs: 120,
          postUrl: "https://example.com",
          postDomHash: "hash1",
          domDiffSummary: { added: 1, removed: 0, changed: 0 },
          eventCount: 2
        }
      ],
      records: []
    };

    const timeline = getTraceTimeline(trace);
    expect(timeline).toHaveLength(2);
    expect(timeline[0].index).toBe(0);
    expect(timeline[1].index).toBe(1);
  });

  it("builds fallback timeline from records when timeline metadata is absent", () => {
    const trace: SavedTrace = {
      version: 2,
      createdAt: new Date().toISOString(),
      sessionId: "timeline-fallback",
      options: {},
      records: [
        {
          action: { type: "navigate", url: "https://example.com" },
          result: {
            status: "ok",
            postDomHash: "hash1",
            durationMs: 200,
            postUrl: "https://example.com",
            eventCount: 5
          }
        }
      ]
    };

    const timeline = getTraceTimeline(trace);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].actionType).toBe("navigate");
    expect(timeline[0].eventCount).toBe(5);
    expect(timeline[0].domDiffSummary.changed).toBe(0);
  });
});
