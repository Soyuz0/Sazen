import { describe, expect, it } from "vitest";
import { buildTimelineHtmlDocument } from "../src/timeline-html.js";
import type { TraceTimelineEntry } from "../src/types.js";

describe("timeline html", () => {
  it("renders timeline rows and metadata", () => {
    const timeline: TraceTimelineEntry[] = [
      {
        index: 0,
        actionType: "navigate",
        status: "ok",
        durationMs: 1200,
        eventCount: 4,
        postUrl: "https://example.com",
        postDomHash: "abc",
        domDiffSummary: { added: 1, removed: 0, changed: 2 },
        screenshotPath: "/tmp/shot.png"
      }
    ];

    const html = buildTimelineHtmlDocument({
      title: "My Timeline",
      tracePath: "/work/trace.json",
      timeline,
      totalRows: 1
    });

    expect(html).toContain("My Timeline");
    expect(html).toContain("https://example.com");
    expect(html).toContain("navigate");
    expect(html).toContain("open");
    expect(html).toContain("Entry Details");
    expect(html).toContain("Status Groups");
    expect(html).toContain("Action Groups");
  });

  it("escapes html-sensitive content", () => {
    const timeline: TraceTimelineEntry[] = [
      {
        index: 0,
        actionType: "snapshot",
        status: "ok",
        durationMs: 10,
        eventCount: 0,
        postUrl: "https://example.com/<script>alert(1)</script>",
        postDomHash: "abc",
        domDiffSummary: { added: 0, removed: 0, changed: 0 }
      }
    ];

    const html = buildTimelineHtmlDocument({
      title: "<unsafe>",
      tracePath: "/tmp/trace.json",
      timeline,
      totalRows: 1
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;unsafe&gt;");
  });
});
