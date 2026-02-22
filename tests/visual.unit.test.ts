import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { comparePngFiles } from "../src/visual.js";

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
