import { describe, expect, it } from "vitest";
import { renderLiveTimelineTuiFrame, toLiveTimelineEntry, type LiveTimelineEntry } from "../src/live-timeline.js";
import type { ActionResult } from "../src/types.js";

describe("live timeline tui", () => {
  it("renders a terminal frame with summary, table, artifacts, and errors", () => {
    const entries: LiveTimelineEntry[] = [
      {
        index: 0,
        actionType: "navigate",
        status: "ok",
        durationMs: 1200,
        events: 4,
        diff: "1/0/2",
        url: "https://example.com",
        artifactPath: "/tmp/shot-1.png"
      },
      {
        index: 1,
        actionType: "click",
        status: "fatal_error",
        durationMs: 900,
        events: 2,
        diff: "0/0/0",
        url: "https://example.com/login",
        errorMessage: "button not found"
      }
    ];

    const frame = renderLiveTimelineTuiFrame({
      entries,
      totalActions: 3,
      completedActions: 2,
      failedActions: 1,
      startedAt: Date.now() - 4_000,
      scriptPath: "/repo/examples/sample-flow.json",
      columns: 120,
      rows: 30
    });

    expect(frame.startsWith("\u001b[2J\u001b[H")).toBe(true);
    expect(frame).toContain("Sazen Live Timeline (TUI)");
    expect(frame).toContain("Completed 2/3 | Failed 1");
    expect(frame).toContain("Recent Artifacts:");
    expect(frame).toContain("/tmp/shot-1.png");
    expect(frame).toContain("Recent Errors:");
    expect(frame).toContain("button not found");
  });

  it("builds timeline entries from action results", () => {
    const fakeResult = {
      action: { type: "snapshot" },
      status: "ok",
      durationMs: 333,
      events: [{ kind: "console" }, { kind: "console" }],
      domDiff: {
        summary: {
          added: 2,
          removed: 1,
          changed: 3
        }
      },
      postSnapshot: {
        url: "https://example.com/final"
      },
      screenshotPath: "/tmp/shot.png",
      annotatedScreenshotPath: "/tmp/shot.annotated.png"
    } as unknown as ActionResult;

    const entry = toLiveTimelineEntry(4, fakeResult);
    expect(entry.index).toBe(4);
    expect(entry.actionType).toBe("snapshot");
    expect(entry.diff).toBe("2/1/3");
    expect(entry.artifactPath).toBe("/tmp/shot.annotated.png");
  });
});
