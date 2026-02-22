import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { annotateActionScreenshot } from "../src/annotate.js";
import type { DomSnapshot } from "../src/types.js";

describe("screenshot annotation", () => {
  it("writes an annotated screenshot when a target node is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sazen-annotate-"));
    const screenshotPath = join(dir, "base.png");

    try {
      const image = new PNG({ width: 120, height: 80 });
      image.data.fill(255);
      await writeFile(screenshotPath, PNG.sync.write(image));

      const snapshot: DomSnapshot = {
        snapshotId: "snap",
        timestamp: Date.now(),
        url: "https://example.com",
        title: "Example",
        domHash: "hash",
        viewport: { width: 120, height: 80 },
        nodeCount: 1,
        interactiveCount: 1,
        nodes: [
          {
            id: "node_1",
            stableRef: "id:submit",
            tag: "button",
            role: "button",
            name: "Submit",
            text: "Submit",
            value: "",
            visible: true,
            enabled: true,
            editable: false,
            interactive: true,
            boundingBox: { x: 10, y: 12, width: 80, height: 30 },
            path: "body > button",
            attributes: { id: "submit" }
          }
        ]
      };

      const annotatedPath = await annotateActionScreenshot({
        screenshotPath,
        action: {
          type: "click",
          target: { kind: "node", nodeId: "node_1" }
        },
        resolvedNodeId: "node_1",
        snapshot
      });

      expect(annotatedPath).toBeTruthy();
      const [baseRaw, annotatedRaw] = await Promise.all([
        readFile(screenshotPath),
        readFile(annotatedPath as string)
      ]);
      expect(annotatedRaw.byteLength).toBeGreaterThan(0);
      expect(annotatedRaw.equals(baseRaw)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
