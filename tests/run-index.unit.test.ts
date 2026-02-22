import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRunArtifactIndex } from "../src/run-index.js";

describe("run artifact index", () => {
  it("collects trace-linked timeline, bundle, visual diff, and error metadata", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-run-index-"));

    const tracePath = join(tempDir, "sample-trace.json");
    const timelineHtmlDir = join(tempDir, "reports", "timeline-html");
    const selectorHealthDir = join(tempDir, "reports", "selector-health");
    const bundleRootDir = join(tempDir, "reports", "triage-bundles");
    const visualDiffRootDir = join(tempDir, "reports", "visual-diff");

    try {
      await mkdir(timelineHtmlDir, { recursive: true });
      await mkdir(selectorHealthDir, { recursive: true });
      await mkdir(join(bundleRootDir, "bundle-a"), { recursive: true });
      await mkdir(join(visualDiffRootDir, "diff-a"), { recursive: true });

      await writeFile(
        tracePath,
        JSON.stringify(
          {
            version: 2,
            createdAt: new Date().toISOString(),
            sessionId: "index-test",
            options: {},
            timeline: [
              {
                index: 0,
                actionType: "navigate",
                status: "ok",
                durationMs: 100,
                postUrl: "https://example.com",
                postDomHash: "h1",
                domDiffSummary: { added: 1, removed: 0, changed: 2 },
                eventCount: 3,
                screenshotPath: join(tempDir, "shot-1.png"),
                annotatedScreenshotPath: join(tempDir, "shot-1.annotated.png")
              }
            ],
            records: [
              {
                action: { type: "navigate", url: "https://example.com" },
                result: {
                  status: "fatal_error",
                  postDomHash: "h1",
                  durationMs: 100,
                  errorMessage: "Timeout while navigating"
                }
              },
              {
                action: { type: "snapshot" },
                result: {
                  status: "ok",
                  postDomHash: "h2",
                  durationMs: 50
                }
              }
            ]
          },
          null,
          2
        ),
        "utf8"
      );

      const traceBase = "sample-trace";
      await writeFile(join(timelineHtmlDir, `${traceBase}.html`), "<html></html>", "utf8");
      await writeFile(
        join(selectorHealthDir, `${traceBase}.selector-health.json`),
        JSON.stringify({ ok: true }, null, 2),
        "utf8"
      );
      await writeFile(
        join(bundleRootDir, "bundle-a", "bundle.json"),
        JSON.stringify({ sourceTracePath: tracePath }, null, 2),
        "utf8"
      );
      await writeFile(
        join(visualDiffRootDir, "diff-a", "report.json"),
        JSON.stringify({ baselineTracePath: tracePath, candidateTracePath: "/tmp/other.json" }, null, 2),
        "utf8"
      );

      const index = await buildRunArtifactIndex(tracePath, {
        timelineHtmlDir,
        selectorHealthDir,
        bundleRootDir,
        visualDiffRootDir
      });

      expect(index.summary.actions).toBe(2);
      expect(index.summary.failedActions).toBe(1);
      expect(index.timelineHtmlPaths).toHaveLength(1);
      expect(index.bundleManifestPaths).toHaveLength(1);
      expect(index.visualDiffReportPaths).toHaveLength(1);
      expect(index.selectorHealthPath).toContain(`${traceBase}.selector-health.json`);
      expect(index.screenshots).toHaveLength(1);
      expect(index.annotatedScreenshots).toHaveLength(1);
      expect(index.topErrors[0].message).toContain("Timeout while navigating");
      expect(index.topErrors[0].count).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
