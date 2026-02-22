import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { getTraceTimeline, loadSavedTrace } from "./trace.js";
import type { RunArtifactIndex } from "./types.js";

export interface RunArtifactIndexOptions {
  timelineHtmlDir?: string;
  selectorHealthDir?: string;
  bundleRootDir?: string;
  visualDiffRootDir?: string;
}

interface BundleManifest {
  sourceTracePath?: string;
  copiedTracePath?: string;
}

interface VisualDiffReportFile {
  baselineTracePath?: string;
  candidateTracePath?: string;
}

export async function buildRunArtifactIndex(
  tracePath: string,
  options: RunArtifactIndexOptions = {}
): Promise<RunArtifactIndex> {
  const timelineHtmlDir = resolve(options.timelineHtmlDir ?? "reports/timeline-html");
  const selectorHealthDir = resolve(options.selectorHealthDir ?? "reports/selector-health");
  const bundleRootDir = resolve(options.bundleRootDir ?? "reports/triage-bundles");
  const visualDiffRootDir = resolve(options.visualDiffRootDir ?? "reports/visual-diff");

  const loaded = await loadSavedTrace(tracePath);
  const absoluteTracePath = loaded.absolutePath;
  const trace = loaded.trace;
  const timeline = getTraceTimeline(trace);
  const traceBase = basename(absoluteTracePath, extname(absoluteTracePath));

  const timelineHtmlPaths: string[] = [];
  const defaultTimelinePath = resolve(timelineHtmlDir, `${traceBase}.html`);
  if (await fileExists(defaultTimelinePath)) {
    timelineHtmlPaths.push(defaultTimelinePath);
  }

  const selectorHealthPath = await resolveExistingPath(
    resolve(selectorHealthDir, `${traceBase}.selector-health.json`)
  );

  const bundleManifestPaths = await discoverBundleManifestPaths(absoluteTracePath, bundleRootDir);
  const visualDiffReportPaths = await discoverVisualDiffReportPaths(absoluteTracePath, visualDiffRootDir);

  const topErrors = buildTopErrors(trace.records.map((record) => record.result.errorMessage).filter(Boolean) as string[]);
  const screenshots = dedupePaths(
    timeline.map((entry) => entry.screenshotPath).filter((value): value is string => typeof value === "string")
  );
  const annotatedScreenshots = dedupePaths(
    timeline
      .map((entry) => entry.annotatedScreenshotPath)
      .filter((value): value is string => typeof value === "string")
  );

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    tracePath: absoluteTracePath,
    summary: {
      actions: trace.records.length,
      failedActions: trace.records.filter((record) => record.result.status !== "ok").length
    },
    selectorHealthPath: selectorHealthPath ?? undefined,
    timelineHtmlPaths,
    bundleManifestPaths,
    visualDiffReportPaths,
    screenshots,
    annotatedScreenshots,
    topErrors
  };
}

async function discoverBundleManifestPaths(tracePath: string, rootDir: string): Promise<string[]> {
  const manifests = await collectFiles(rootDir, "bundle.json");
  const matched: string[] = [];

  for (const manifestPath of manifests) {
    const raw = await safeReadJson<BundleManifest>(manifestPath);
    if (!raw) {
      continue;
    }

    const source = raw.sourceTracePath ? resolve(raw.sourceTracePath) : undefined;
    const copy = raw.copiedTracePath ? resolve(raw.copiedTracePath) : undefined;
    if (source === tracePath || copy === tracePath) {
      matched.push(manifestPath);
    }
  }

  return matched;
}

async function discoverVisualDiffReportPaths(tracePath: string, rootDir: string): Promise<string[]> {
  const reports = await collectFiles(rootDir, "report.json");
  const matched: string[] = [];

  for (const reportPath of reports) {
    const raw = await safeReadJson<VisualDiffReportFile>(reportPath);
    if (!raw) {
      continue;
    }

    const baseline = raw.baselineTracePath ? resolve(raw.baselineTracePath) : undefined;
    const candidate = raw.candidateTracePath ? resolve(raw.candidateTracePath) : undefined;
    if (baseline === tracePath || candidate === tracePath) {
      matched.push(reportPath);
    }
  }

  return matched;
}

function buildTopErrors(messages: string[]): RunArtifactIndex["topErrors"] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const normalized = normalizeErrorMessage(message);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([message, count]) => ({ message, count }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.message.localeCompare(right.message);
    })
    .slice(0, 8);
}

function normalizeErrorMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ").slice(0, 400);
}

function dedupePaths(values: string[]): string[] {
  return [...new Set(values.map((value) => resolve(value)))];
}

async function resolveExistingPath(path: string): Promise<string | undefined> {
  return (await fileExists(path)) ? path : undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  }
}

async function collectFiles(rootDir: string, fileName: string): Promise<string[]> {
  const files: string[] = [];

  if (!(await fileExists(rootDir))) {
    return files;
  }

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: Dirent<string>[];
    try {
      entries = await readdir(current, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile() && entry.name === fileName) {
        files.push(absolute);
      }
    }
  }

  return files;
}

async function safeReadJson<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
