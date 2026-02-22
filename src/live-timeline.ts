import type { ActionResult } from "./types.js";

export interface LiveTimelineEntry {
  index: number;
  actionType: string;
  status: string;
  durationMs: number;
  events: number;
  diff: string;
  url: string;
  artifactPath?: string;
  errorMessage?: string;
}

export interface LiveTimelineFrameInput {
  entries: LiveTimelineEntry[];
  totalActions: number;
  completedActions: number;
  failedActions: number;
  startedAt: number;
  scriptPath?: string;
  columns?: number;
  rows?: number;
}

export function toLiveTimelineEntry(index: number, result: ActionResult): LiveTimelineEntry {
  return {
    index,
    actionType: result.action.type,
    status: result.status,
    durationMs: result.durationMs,
    events: result.events.length,
    diff: `${result.domDiff.summary.added}/${result.domDiff.summary.removed}/${result.domDiff.summary.changed}`,
    url: result.postSnapshot.url,
    artifactPath: result.annotatedScreenshotPath ?? result.screenshotPath,
    errorMessage: result.error?.message
  };
}

export function renderLiveTimelineTuiFrame(input: LiveTimelineFrameInput): string {
  const columns = Math.max(80, input.columns ?? 120);
  const rows = Math.max(18, input.rows ?? 30);
  const elapsedMs = Math.max(0, Date.now() - input.startedAt);
  const statusLine =
    `Completed ${input.completedActions}/${input.totalActions}` +
    ` | Failed ${input.failedActions}` +
    ` | Elapsed ${formatElapsed(elapsedMs)}`;

  const headerLine = "#  action         status           dur      events diff      url";
  const maxTableRows = Math.max(5, rows - 12);
  const visibleRows = input.entries.slice(-maxTableRows);

  const tableLines = visibleRows.map((entry) =>
    [
      String(entry.index + 1).padStart(2, " "),
      pad(entry.actionType, 13),
      pad(entry.status, 15),
      pad(`${entry.durationMs}ms`, 8),
      pad(String(entry.events), 6),
      pad(entry.diff, 9),
      truncate(entry.url || "(unknown)", Math.max(16, columns - 64))
    ].join(" ")
  );

  const recentArtifacts = input.entries
    .filter((entry) => typeof entry.artifactPath === "string" && entry.artifactPath.length > 0)
    .slice(-3)
    .map((entry) => `#${entry.index + 1} ${entry.actionType}: ${entry.artifactPath}`);

  const recentErrors = input.entries
    .filter((entry) => typeof entry.errorMessage === "string" && entry.errorMessage.length > 0)
    .slice(-2)
    .map((entry) => `#${entry.index + 1} ${entry.actionType}: ${entry.errorMessage}`);

  const lines: string[] = [];
  lines.push("Sazen Live Timeline (TUI)");
  if (input.scriptPath) {
    lines.push(`Script: ${truncate(input.scriptPath, columns - 8)}`);
  }
  lines.push(statusLine);
  lines.push("-".repeat(Math.max(10, Math.min(columns, 120))));
  lines.push(headerLine);
  if (tableLines.length === 0) {
    lines.push("(no actions completed yet)");
  } else {
    lines.push(...tableLines);
  }
  lines.push("");
  lines.push("Recent Artifacts:");
  if (recentArtifacts.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(...recentArtifacts.map((line) => truncate(line, columns - 2)));
  }
  lines.push("");
  lines.push("Recent Errors:");
  if (recentErrors.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(...recentErrors.map((line) => truncate(line, columns - 2)));
  }

  const frame = lines.map((line) => truncate(line, columns - 1)).join("\n");
  return `\u001b[2J\u001b[H${frame}`;
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function truncate(input: string, max: number): string {
  if (max <= 3) {
    return input.slice(0, Math.max(0, max));
  }
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 3)}...`;
}

function pad(input: string, width: number): string {
  if (input.length >= width) {
    return input;
  }
  return `${input}${" ".repeat(width - input.length)}`;
}
