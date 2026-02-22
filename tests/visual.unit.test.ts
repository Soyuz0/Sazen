import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { comparePngFiles, compareTraceVisuals } from "../src/visual.js";

describe("visual diff", () => {
  it("detects identical images", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-visual-identical-"));
    const baseline = join(dir, "baseline.png");
    const candidate = join(dir, "candidate.png");
    const diffPath = join(dir, "diff.png");

    try {
      await writeSolidPng(baseline, 4, 4, [255, 255, 255, 255]);
      await writeSolidPng(candidate, 4, 4, [255, 255, 255, 255]);

      const result = await comparePngFiles(baseline, candidate, { diffPath });
      expect(result.status).toBe("ok");
      expect(result.mismatchPixels).toBe(0);

      const diff = await readFile(diffPath);
      expect(diff.byteLength).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detects changed pixels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-visual-diff-"));
    const baseline = join(dir, "baseline.png");
    const candidate = join(dir, "candidate.png");

    try {
      await writeSolidPng(baseline, 4, 4, [255, 255, 255, 255]);
      await writeSolidPng(candidate, 4, 4, [255, 255, 255, 255]);

      const raw = await readFile(candidate);
      const image = PNG.sync.read(raw);
      image.data[0] = 0;
      image.data[1] = 0;
      image.data[2] = 0;
      await writeFile(candidate, PNG.sync.write(image));

      const result = await comparePngFiles(baseline, candidate);
      expect(result.status).toBe("different");
      expect(result.mismatchPixels).toBeGreaterThan(0);
      expect(result.mismatchRatio).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports size mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-visual-size-"));
    const baseline = join(dir, "baseline.png");
    const candidate = join(dir, "candidate.png");

    try {
      await writeSolidPng(baseline, 4, 4, [255, 255, 255, 255]);
      await writeSolidPng(candidate, 5, 4, [255, 255, 255, 255]);

      const result = await comparePngFiles(baseline, candidate);
      expect(result.status).toBe("size_mismatch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores pause provenance markers when comparing traces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-browser-visual-trace-"));
    const baselineTrace = join(dir, "baseline-trace.json");
    const candidateTrace = join(dir, "candidate-trace.json");
    const baselineShot = join(dir, "baseline.png");
    const candidateShot = join(dir, "candidate.png");

    try {
      await writeSolidPng(baselineShot, 4, 4, [255, 255, 255, 255]);
      await writeSolidPng(candidateShot, 4, 4, [255, 255, 255, 255]);

      const baseTimeline = [
        {
          index: 0,
          actionType: "pause_start",
          status: "ok",
          durationMs: 0,
          postUrl: "https://example.com",
          postDomHash: "h0",
          domDiffSummary: { added: 0, removed: 0, changed: 0 },
          eventCount: 0
        },
        {
          index: 1,
          actionType: "navigate",
          status: "ok",
          durationMs: 10,
          postUrl: "https://example.com",
          postDomHash: "h1",
          domDiffSummary: { added: 0, removed: 0, changed: 0 },
          eventCount: 0,
          screenshotPath: baselineShot,
          target: {
            role: "button",
            name: "Search",
            boundingBox: { x: 1, y: 1, width: 2, height: 2 }
          }
        }
      ];

      const candidateTimeline = [
        {
          index: 0,
          actionType: "pause_resume",
          status: "ok",
          durationMs: 100,
          postUrl: "https://example.com",
          postDomHash: "h0b",
          domDiffSummary: { added: 0, removed: 0, changed: 0 },
          eventCount: 0
        },
        {
          index: 1,
          actionType: "navigate",
          status: "ok",
          durationMs: 12,
          postUrl: "https://example.com",
          postDomHash: "h1b",
          domDiffSummary: { added: 0, removed: 0, changed: 0 },
          eventCount: 0,
          screenshotPath: candidateShot,
          target: {
            role: "button",
            name: "Search",
            boundingBox: { x: 1, y: 1, width: 2, height: 2 }
          }
        }
      ];

      await writeFile(
        baselineTrace,
        JSON.stringify(
          {
            version: 2,
            createdAt: new Date().toISOString(),
            sessionId: "baseline",
            options: {},
            timeline: baseTimeline,
            records: []
          },
          null,
          2
        ),
        "utf8"
      );

      await writeFile(
        candidateTrace,
        JSON.stringify(
          {
            version: 2,
            createdAt: new Date().toISOString(),
            sessionId: "candidate",
            options: {},
            timeline: candidateTimeline,
            records: []
          },
          null,
          2
        ),
        "utf8"
      );

      const report = await compareTraceVisuals(baselineTrace, candidateTrace, {
        outDir: join(dir, "diff"),
        writeDiffImages: false
      });

      expect(report.compared).toBe(1);
      expect(report.missing).toBe(0);
      expect(report.entries).toHaveLength(1);
      expect(report.entries[0].actionType).toBe("navigate");
      expect(report.entries[0].targetLabel).toBe("Search");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function writeSolidPng(
  outputPath: string,
  width: number,
  height: number,
  rgba: [number, number, number, number]
): Promise<void> {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  await writeFile(outputPath, PNG.sync.write(png));
}
