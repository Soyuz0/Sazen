import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getTraceTimeline, loadSavedTrace } from "./trace.js";
import type { TraceTimelineEntry } from "./types.js";

export interface TimelineHtmlOptions {
  outDir?: string;
  title?: string;
  limit?: number;
}

export async function writeTimelineHtmlReport(
  tracePath: string,
  options: TimelineHtmlOptions = {}
): Promise<{ htmlPath: string; rows: number }> {
  const { absolutePath, trace } = await loadSavedTrace(tracePath);
  const timeline = getTraceTimeline(trace);
  const limit = options.limit ?? timeline.length;
  const selected = timeline.slice(0, limit);

  const outDir = resolve(options.outDir ?? "reports/timeline-html");
  await mkdir(outDir, { recursive: true });
  const htmlPath = join(outDir, `${basename(absolutePath, ".json")}.html`);

  const html = buildTimelineHtmlDocument({
    title: options.title ?? `Trace Timeline: ${basename(absolutePath)}`,
    tracePath: absolutePath,
    timeline: selected,
    totalRows: timeline.length
  });

  await writeFile(htmlPath, html, "utf8");
  return {
    htmlPath,
    rows: selected.length
  };
}

export function buildTimelineHtmlDocument(input: {
  title: string;
  tracePath: string;
  timeline: TraceTimelineEntry[];
  totalRows: number;
}): string {
  const rows = input.timeline
    .map((entry) => {
      const artifactPath = entry.annotatedScreenshotPath ?? entry.screenshotPath;
      const screenshot = artifactPath
        ? `<a href="${escapeHtml(fileUrl(artifactPath))}" target="_blank" rel="noopener">open</a>`
        : "";
      const preview = artifactPath
        ? `<img loading="lazy" src="${escapeHtml(fileUrl(artifactPath))}" alt="screenshot" />`
        : "";
      const controlSummary = entry.control
        ? `<div class="control-note">${escapeHtml(
            `phase=${entry.control.phase} elapsed=${entry.control.elapsedMs ?? 0}ms sources=${
              entry.control.sources.join(",") || "none"
            } urlChanged=${Boolean(entry.control.urlChanged)} domChanged=${Boolean(entry.control.domChanged)}`
          )}</div>`
        : "";

      return `
      <tr data-status="${escapeHtml(entry.status)}" data-action="${escapeHtml(entry.actionType)}">
        <td>${entry.index + 1}</td>
        <td>${escapeHtml(entry.actionType)}</td>
        <td>${escapeHtml(entry.status)}</td>
        <td>${entry.durationMs}ms</td>
        <td>${entry.eventCount}</td>
        <td>${entry.domDiffSummary.added}/${entry.domDiffSummary.removed}/${entry.domDiffSummary.changed}</td>
        <td title="${escapeHtml(entry.postUrl)}">${escapeHtml(truncate(entry.postUrl, 70))}${controlSummary}</td>
        <td>${screenshot}</td>
      </tr>
      <tr class="preview-row" data-preview-status="${escapeHtml(entry.status)}" data-preview-action="${escapeHtml(entry.actionType)}">
        <td colspan="8">${preview}</td>
      </tr>
    `;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(input.title)}</title>
  <style>
    body { font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 20px; background: #f4f6fb; color: #111827; }
    h1 { margin: 0 0 8px; }
    p.meta { margin: 0 0 16px; color: #4b5563; }
    .controls { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    input, select { height: 34px; border: 1px solid #cdd5df; border-radius: 8px; padding: 0 10px; background: white; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d9dfeb; }
    th, td { border-bottom: 1px solid #e8edf5; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #eef2ff; position: sticky; top: 0; }
    tr.preview-row td { background: #fafcff; }
    tr.preview-row img { max-width: 100%; border: 1px solid #dbe2ee; border-radius: 8px; }
    .control-note { margin-top: 4px; color: #475569; font-size: 12px; }
  </style>
</head>
<body>
  <h1>${escapeHtml(input.title)}</h1>
  <p class="meta">${escapeHtml(input.tracePath)} | showing ${input.timeline.length}/${input.totalRows} rows</p>
  <div class="controls">
    <select id="statusFilter">
      <option value="">All statuses</option>
      <option value="ok">ok</option>
      <option value="retryable_error">retryable_error</option>
      <option value="fatal_error">fatal_error</option>
    </select>
    <input id="actionFilter" placeholder="Filter action type" />
  </div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Action</th>
        <th>Status</th>
        <th>Duration</th>
        <th>Events</th>
        <th>Diff</th>
        <th>URL</th>
        <th>Artifact</th>
      </tr>
    </thead>
    <tbody id="rows">
      ${rows}
    </tbody>
  </table>
  <script>
    const statusFilter = document.getElementById('statusFilter');
    const actionFilter = document.getElementById('actionFilter');
    const rows = Array.from(document.querySelectorAll('tbody tr[data-status]'));

    function applyFilters() {
      const status = statusFilter.value.trim();
      const action = actionFilter.value.trim().toLowerCase();

      for (const row of rows) {
        const matchesStatus = !status || row.dataset.status === status;
        const matchesAction = !action || (row.dataset.action || '').toLowerCase().includes(action);
        const visible = matchesStatus && matchesAction;
        row.style.display = visible ? '' : 'none';

        const preview = row.nextElementSibling;
        if (preview && preview.classList.contains('preview-row')) {
          preview.style.display = visible ? '' : 'none';
        }
      }
    }

    statusFilter.addEventListener('change', applyFilters);
    actionFilter.addEventListener('input', applyFilters);
  </script>
</body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 1)}...`;
}

function fileUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : resolve(path);
  return `file://${normalized}`;
}
