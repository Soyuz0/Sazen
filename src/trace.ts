import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DomDiffSummary, SavedTrace, TraceTimelineEntry } from "./types.js";

const EMPTY_DIFF: DomDiffSummary = {
  added: 0,
  removed: 0,
  changed: 0
};

export async function loadSavedTrace(
  tracePath: string
): Promise<{ absolutePath: string; trace: SavedTrace }> {
  const absolutePath = resolve(tracePath);
  const raw = await readFile(absolutePath, "utf8");
  const trace = JSON.parse(raw) as SavedTrace;
  return { absolutePath, trace };
}

export function getTraceTimeline(trace: SavedTrace): TraceTimelineEntry[] {
  if (trace.timeline && trace.timeline.length > 0) {
    return [...trace.timeline].sort((left, right) => left.index - right.index);
  }

  return trace.records.map((record, index) => ({
    index,
    actionType: record.action.type,
    status: record.result.status,
    durationMs: record.result.durationMs,
    postUrl: record.result.postUrl ?? "",
    postDomHash: record.result.postDomHash,
    domDiffSummary: EMPTY_DIFF,
    eventCount: record.result.eventCount ?? 0
  }));
}
