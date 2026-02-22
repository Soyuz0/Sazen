import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { getTraceTimeline, loadSavedTrace } from "./trace.js";
import type { Action, BoundingBox, TraceTimelineEntry, VisualDiffEntry, VisualDiffReport } from "./types.js";

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
  preferAnnotatedArtifacts?: boolean;
}

const DEFAULT_TRACE_OPTIONS: Required<CompareTraceVisualOptions> = {
  outDir: "reports/visual-diff",
  threshold: 0.1,
  maxSteps: Number.MAX_SAFE_INTEGER,
  writeDiffImages: true,
  preferAnnotatedArtifacts: false
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

  const baselineTimeline = getTraceTimeline(baselineTrace.trace).filter(isVisualComparableTimelineEntry);
  const candidateTimeline = getTraceTimeline(candidateTrace.trace).filter(isVisualComparableTimelineEntry);
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
    const actionType: Action["type"] = candidateEntry?.actionType ?? baselineEntry?.actionType ?? "snapshot";

    const baselineArtifact = chooseArtifactPath(baselineEntry, effective.preferAnnotatedArtifacts);
    const candidateArtifact = chooseArtifactPath(candidateEntry, effective.preferAnnotatedArtifacts);
    const baselineTargetBox = baselineEntry?.target?.boundingBox;
    const candidateTargetBox = candidateEntry?.target?.boundingBox;
    const targetLabel = buildTargetLabel(candidateEntry) ?? buildTargetLabel(baselineEntry);

    const entry: VisualDiffEntry = {
      index,
      actionType,
      baselineScreenshotPath: baselineArtifact,
      candidateScreenshotPath: candidateArtifact,
      status: "ok",
      mismatchPixels: 0,
      totalPixels: 0,
      mismatchRatio: 0,
      targetLabel,
      baselineTargetBox,
      candidateTargetBox
    };

    if (!baselineArtifact) {
      entry.status = "missing_baseline";
      resultEntries.push(entry);
      continue;
    }

    if (!candidateArtifact) {
      entry.status = "missing_candidate";
      resultEntries.push(entry);
      continue;
    }

    const diffPath = effective.writeDiffImages
      ? join(diffRoot, `${String(index + 1).padStart(4, "0")}-${actionType}.png`)
      : undefined;

    try {
      const compared = await comparePngFiles(baselineArtifact, candidateArtifact, {
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
        await annotateDiffImage(compared.diffImagePath, {
          baselineTargetBox,
          candidateTargetBox,
          targetLabel
        }).catch(() => undefined);
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

function chooseArtifactPath(
  entry: { screenshotPath?: string; annotatedScreenshotPath?: string } | undefined,
  preferAnnotated: boolean
): string | undefined {
  if (!entry) {
    return undefined;
  }

  if (preferAnnotated) {
    return entry.annotatedScreenshotPath ?? entry.screenshotPath;
  }

  return entry.screenshotPath ?? entry.annotatedScreenshotPath;
}

function isVisualComparableTimelineEntry(
  entry: TraceTimelineEntry
): entry is TraceTimelineEntry & { actionType: Action["type"] } {
  return entry.actionType !== "pause_start" && entry.actionType !== "pause_resume";
}

function buildTargetLabel(entry: TraceTimelineEntry | undefined): string | undefined {
  if (!entry?.target) {
    return undefined;
  }

  const raw =
    entry.target.name?.trim() ||
    entry.target.stableRef?.trim() ||
    entry.target.role?.trim() ||
    entry.target.nodeId?.trim();
  if (!raw) {
    return undefined;
  }

  return truncateLabel(raw, 36);
}

async function annotateDiffImage(
  imagePath: string,
  input: {
    baselineTargetBox?: BoundingBox;
    candidateTargetBox?: BoundingBox;
    targetLabel?: string;
  }
): Promise<void> {
  if (!input.baselineTargetBox && !input.candidateTargetBox) {
    return;
  }

  const raw = await readFile(imagePath);
  const png = PNG.sync.read(raw);

  if (input.baselineTargetBox) {
    drawRect(png, input.baselineTargetBox, [244, 63, 94, 255], 2);
  }
  if (input.candidateTargetBox) {
    drawRect(png, input.candidateTargetBox, [14, 165, 233, 255], 2);
  }

  const baselineLabel = input.targetLabel ? `B:${sanitizeLabel(input.targetLabel)}` : "B:TARGET";
  const candidateLabel = input.targetLabel ? `C:${sanitizeLabel(input.targetLabel)}` : "C:TARGET";
  drawTextWithBackground(png, 8, 8, baselineLabel, [244, 63, 94, 255]);
  drawTextWithBackground(png, 8, 22, candidateLabel, [14, 165, 233, 255]);

  await writeFile(imagePath, PNG.sync.write(png));
}

function drawRect(png: PNG, box: BoundingBox, color: [number, number, number, number], thickness: number): void {
  const left = clamp(Math.floor(box.x), 0, png.width - 1);
  const top = clamp(Math.floor(box.y), 0, png.height - 1);
  const right = clamp(Math.ceil(box.x + box.width), 0, png.width - 1);
  const bottom = clamp(Math.ceil(box.y + box.height), 0, png.height - 1);

  if (right <= left || bottom <= top) {
    return;
  }

  for (let t = 0; t < thickness; t += 1) {
    for (let x = left; x <= right; x += 1) {
      setPixel(png, x, clamp(top + t, 0, png.height - 1), color);
      setPixel(png, x, clamp(bottom - t, 0, png.height - 1), color);
    }
    for (let y = top; y <= bottom; y += 1) {
      setPixel(png, clamp(left + t, 0, png.width - 1), y, color);
      setPixel(png, clamp(right - t, 0, png.width - 1), y, color);
    }
  }
}

function drawTextWithBackground(
  png: PNG,
  x: number,
  y: number,
  text: string,
  accent: [number, number, number, number]
): void {
  const content = sanitizeLabel(text).toUpperCase();
  const width = content.length * 4 + 6;
  const height = 11;

  fillRect(png, x, y, width, height, [15, 23, 42, 210]);
  fillRect(png, x, y, 2, height, accent);
  drawTinyText(png, x + 4, y + 2, content, [248, 250, 252, 255]);
}

function drawTinyText(
  png: PNG,
  x: number,
  y: number,
  text: string,
  color: [number, number, number, number]
): void {
  const font = tinyFontMap();
  let cursor = x;
  for (const char of text) {
    const glyph = font.get(char) ?? font.get("?");
    if (!glyph) {
      cursor += 4;
      continue;
    }

    for (let row = 0; row < glyph.length; row += 1) {
      const pattern = glyph[row];
      for (let col = 0; col < pattern.length; col += 1) {
        if (pattern[col] === "1") {
          setPixel(png, cursor + col, y + row, color);
        }
      }
    }

    cursor += 4;
  }
}

function fillRect(
  png: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  color: [number, number, number, number]
): void {
  const startX = clamp(x, 0, png.width - 1);
  const endX = clamp(x + width, 0, png.width);
  const startY = clamp(y, 0, png.height - 1);
  const endY = clamp(y + height, 0, png.height);
  for (let py = startY; py < endY; py += 1) {
    for (let px = startX; px < endX; px += 1) {
      setPixel(png, px, py, color);
    }
  }
}

function setPixel(png: PNG, x: number, y: number, color: [number, number, number, number]): void {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) {
    return;
  }
  const offset = (png.width * y + x) << 2;
  png.data[offset] = color[0];
  png.data[offset + 1] = color[1];
  png.data[offset + 2] = color[2];
  png.data[offset + 3] = color[3];
}

function sanitizeLabel(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function truncateLabel(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 1)}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function tinyFontMap(): Map<string, string[]> {
  return new Map<string, string[]>([
    ["A", ["010", "101", "111", "101", "101"]],
    ["B", ["110", "101", "110", "101", "110"]],
    ["C", ["011", "100", "100", "100", "011"]],
    ["D", ["110", "101", "101", "101", "110"]],
    ["E", ["111", "100", "110", "100", "111"]],
    ["F", ["111", "100", "110", "100", "100"]],
    ["G", ["011", "100", "101", "101", "011"]],
    ["H", ["101", "101", "111", "101", "101"]],
    ["I", ["111", "010", "010", "010", "111"]],
    ["J", ["001", "001", "001", "101", "010"]],
    ["K", ["101", "101", "110", "101", "101"]],
    ["L", ["100", "100", "100", "100", "111"]],
    ["M", ["101", "111", "111", "101", "101"]],
    ["N", ["101", "111", "111", "111", "101"]],
    ["O", ["010", "101", "101", "101", "010"]],
    ["P", ["110", "101", "110", "100", "100"]],
    ["Q", ["010", "101", "101", "111", "011"]],
    ["R", ["110", "101", "110", "101", "101"]],
    ["S", ["011", "100", "010", "001", "110"]],
    ["T", ["111", "010", "010", "010", "010"]],
    ["U", ["101", "101", "101", "101", "111"]],
    ["V", ["101", "101", "101", "101", "010"]],
    ["W", ["101", "101", "111", "111", "101"]],
    ["X", ["101", "101", "010", "101", "101"]],
    ["Y", ["101", "101", "010", "010", "010"]],
    ["Z", ["111", "001", "010", "100", "111"]],
    ["0", ["111", "101", "101", "101", "111"]],
    ["1", ["010", "110", "010", "010", "111"]],
    ["2", ["110", "001", "010", "100", "111"]],
    ["3", ["110", "001", "010", "001", "110"]],
    ["4", ["101", "101", "111", "001", "001"]],
    ["5", ["111", "100", "110", "001", "110"]],
    ["6", ["011", "100", "110", "101", "010"]],
    ["7", ["111", "001", "010", "010", "010"]],
    ["8", ["010", "101", "010", "101", "010"]],
    ["9", ["010", "101", "011", "001", "110"]],
    [":", ["000", "010", "000", "010", "000"]],
    ["-", ["000", "000", "111", "000", "000"]],
    ["_", ["000", "000", "000", "000", "111"]],
    ["/", ["001", "001", "010", "100", "100"]],
    [".", ["000", "000", "000", "000", "010"]],
    ["#", ["010", "111", "010", "111", "010"]],
    [" ", ["000", "000", "000", "000", "000"]],
    ["?", ["110", "001", "010", "000", "010"]]
  ]);
}
