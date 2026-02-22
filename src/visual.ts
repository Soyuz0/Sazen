import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { getTraceTimeline, loadSavedTrace } from "./trace.js";
import type { VisualDiffEntry, VisualDiffReport } from "./types.js";

export interface ComparePngOptions {
  threshold?: number;
  diffPath?: string;
}

export interface ComparePngResult {
  status: "ok" | "different" | "size_mismatch";
  mismatchPixels: number;
  totalPixels: number;
  mismatchRatio: number;
  width?: number;
  height?: number;
  diffImagePath?: string;
}

export interface CompareTraceVisualOptions {
  outDir?: string;
  threshold?: number;
  maxSteps?: number;
  writeDiffImages?: boolean;
}

const DEFAULT_TRACE_OPTIONS: Required<CompareTraceVisualOptions> = {
  outDir: "reports/visual-diff",
  threshold: 0.1,
  maxSteps: Number.MAX_SAFE_INTEGER,
  writeDiffImages: true
};

export async function comparePngFiles(
  baselinePath: string,
  candidatePath: string,
  options: ComparePngOptions = {}
): Promise<ComparePngResult> {
  const [baselineRaw, candidateRaw] = await Promise.all([readFile(baselinePath), readFile(candidatePath)]);
  const baseline = PNG.sync.read(baselineRaw);
  const candidate = PNG.sync.read(candidateRaw);

  if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
    return {
      status: "size_mismatch",
      mismatchPixels: 0,
      totalPixels: 0,
      mismatchRatio: 1,
      width: baseline.width,
      height: baseline.height
    };
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const mismatchPixels = pixelmatch(
    baseline.data,
    candidate.data,
    diff.data,
    baseline.width,
    baseline.height,
    {
      threshold: options.threshold ?? 0.1
    }
  );

  const totalPixels = baseline.width * baseline.height;
  const mismatchRatio = totalPixels > 0 ? mismatchPixels / totalPixels : 0;

  if (options.diffPath) {
    await mkdir(dirname(options.diffPath), { recursive: true });
    await writeFile(options.diffPath, PNG.sync.write(diff));
  }

  return {
    status: mismatchPixels > 0 ? "different" : "ok",
    mismatchPixels,
    totalPixels,
    mismatchRatio,
    width: baseline.width,
    height: baseline.height,
    diffImagePath: options.diffPath
  };
}

export async function compareTraceVisuals(
  baselineTracePath: string,
  candidateTracePath: string,
  options: CompareTraceVisualOptions = {}
): Promise<VisualDiffReport> {
  const effective = { ...DEFAULT_TRACE_OPTIONS, ...options };
  const baselineTrace = await loadSavedTrace(baselineTracePath);
  const candidateTrace = await loadSavedTrace(candidateTracePath);

  const baselineTimeline = getTraceTimeline(baselineTrace.trace);
  const candidateTimeline = getTraceTimeline(candidateTrace.trace);
  const maxSteps = Math.min(effective.maxSteps, Math.max(baselineTimeline.length, candidateTimeline.length));

  const resultEntries: VisualDiffEntry[] = [];

  const diffRoot = resolve(
    effective.outDir,
    `${basename(baselineTrace.absolutePath, ".json")}-vs-${basename(candidateTrace.absolutePath, ".json")}`
  );
  await mkdir(diffRoot, { recursive: true });

  for (let index = 0; index < maxSteps; index += 1) {
    const baselineEntry = baselineTimeline[index];
    const candidateEntry = candidateTimeline[index];
    const actionType = candidateEntry?.actionType ?? baselineEntry?.actionType ?? "snapshot";

    const entry: VisualDiffEntry = {
      index,
      actionType,
      baselineScreenshotPath: baselineEntry?.screenshotPath,
      candidateScreenshotPath: candidateEntry?.screenshotPath,
      status: "ok",
      mismatchPixels: 0,
      totalPixels: 0,
      mismatchRatio: 0
    };

    if (!baselineEntry?.screenshotPath) {
      entry.status = "missing_baseline";
      resultEntries.push(entry);
      continue;
    }

    if (!candidateEntry?.screenshotPath) {
      entry.status = "missing_candidate";
      resultEntries.push(entry);
      continue;
    }

    const diffPath = effective.writeDiffImages
      ? join(diffRoot, `${String(index + 1).padStart(4, "0")}-${actionType}.png`)
      : undefined;

    try {
      const compared = await comparePngFiles(baselineEntry.screenshotPath, candidateEntry.screenshotPath, {
        threshold: effective.threshold,
        diffPath
      });

      entry.status = compared.status;
      entry.mismatchPixels = compared.mismatchPixels;
      entry.totalPixels = compared.totalPixels;
      entry.mismatchRatio = compared.mismatchRatio;
      entry.width = compared.width;
      entry.height = compared.height;
      if (compared.diffImagePath) {
        entry.diffImagePath = compared.diffImagePath;
      }
    } catch {
      entry.status = "size_mismatch";
      entry.mismatchRatio = 1;
    }

    resultEntries.push(entry);
  }

  const report: VisualDiffReport = {
    baselineTracePath: baselineTrace.absolutePath,
    candidateTracePath: candidateTrace.absolutePath,
    compared: resultEntries.filter((entry) => entry.status === "ok" || entry.status === "different").length,
    different: resultEntries.filter((entry) => entry.status === "different").length,
    missing: resultEntries.filter(
      (entry) => entry.status === "missing_baseline" || entry.status === "missing_candidate"
    ).length,
    sizeMismatches: resultEntries.filter((entry) => entry.status === "size_mismatch").length,
    entries: resultEntries
  };

  return report;
}
