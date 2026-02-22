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
  const timelineJson = safeJsonForInlineScript(input.timeline);
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
      const targetSummary = entry.target
        ? `<div class="control-note">${escapeHtml(
            `target=${entry.target.name || entry.target.stableRef || entry.target.role || entry.target.nodeId || "(unknown)"}`
          )}</div>`
        : "";

      return `
      <tr data-status="${escapeHtml(entry.status)}" data-action="${escapeHtml(entry.actionType)}" data-index="${entry.index}">
        <td>${entry.index + 1}</td>
        <td>${escapeHtml(entry.actionType)}</td>
        <td>${escapeHtml(entry.status)}</td>
        <td>${entry.durationMs}ms</td>
        <td>${entry.eventCount}</td>
        <td>${entry.domDiffSummary.added}/${entry.domDiffSummary.removed}/${entry.domDiffSummary.changed}</td>
        <td title="${escapeHtml(entry.postUrl)}">${escapeHtml(truncate(entry.postUrl, 70))}${controlSummary}${targetSummary}</td>
        <td>${screenshot}</td>
      </tr>
      <tr class="preview-row" data-preview-status="${escapeHtml(entry.status)}" data-preview-action="${escapeHtml(entry.actionType)}" data-preview-for="${entry.index}">
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
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
    .summary { background: white; border: 1px solid #d9dfeb; border-radius: 10px; padding: 12px; margin-bottom: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .summary h2 { margin: 0 0 6px; font-size: 14px; }
    .summary ul { margin: 0; padding-left: 18px; font-size: 13px; color: #334155; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d9dfeb; }
    th, td { border-bottom: 1px solid #e8edf5; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #eef2ff; position: sticky; top: 0; }
    tr[data-index] { cursor: pointer; }
    tr[data-index].selected td { background: #eef6ff; }
    tr.preview-row td { background: #fafcff; }
    tr.preview-row img { max-width: 100%; border: 1px solid #dbe2ee; border-radius: 8px; }
    .control-note { margin-top: 4px; color: #475569; font-size: 12px; }
    .details { background: white; border: 1px solid #d9dfeb; border-radius: 10px; padding: 12px; position: sticky; top: 12px; }
    .details h2 { margin: 0 0 8px; font-size: 16px; }
    .details pre { margin: 0; max-height: 70vh; overflow: auto; background: #0f172a; color: #e2e8f0; padding: 10px; border-radius: 8px; font-size: 12px; }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .details { position: static; }
    }
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
    <input id="textFilter" placeholder="Search URL/hash/target" />
  </div>
  <div class="summary">
    <div>
      <h2>Status Groups</h2>
      <ul id="statusSummary"></ul>
    </div>
    <div>
      <h2>Action Groups</h2>
      <ul id="actionSummary"></ul>
    </div>
  </div>
  <div class="layout">
    <div>
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
    </div>
    <aside class="details">
      <h2>Entry Details</h2>
      <pre id="detailsPane">Select a timeline row to inspect full metadata.</pre>
    </aside>
  </div>
  <script>
    const timeline = ${timelineJson};
    const statusFilter = document.getElementById('statusFilter');
    const actionFilter = document.getElementById('actionFilter');
    const textFilter = document.getElementById('textFilter');
    const rows = Array.from(document.querySelectorAll('tbody tr[data-status]'));
    const statusSummary = document.getElementById('statusSummary');
    const actionSummary = document.getElementById('actionSummary');
    const detailsPane = document.getElementById('detailsPane');

    let selectedIndex = null;

    function updateSummary(target, counts) {
      const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
      if (entries.length === 0) {
        target.innerHTML = '<li>(none)</li>';
        return;
      }
      target.innerHTML = entries.map(([key, value]) => '<li>' + key + ': ' + value + '</li>').join('');
    }

    function showEntry(index) {
      const entry = timeline.find((item) => item.index === index);
      if (!entry) {
        detailsPane.textContent = 'No details available.';
        return;
      }

      selectedIndex = index;
      for (const row of rows) {
        row.classList.toggle('selected', Number(row.dataset.index) === index);
      }
      detailsPane.textContent = JSON.stringify(entry, null, 2);
    }

    for (const row of rows) {
      row.addEventListener('click', () => {
        showEntry(Number(row.dataset.index));
      });
    }

    function applyFilters() {
      const status = statusFilter.value.trim();
      const action = actionFilter.value.trim().toLowerCase();
      const text = textFilter.value.trim().toLowerCase();
      const statusCounts = new Map();
      const actionCounts = new Map();
      let firstVisible = null;

      for (const row of rows) {
        const matchesStatus = !status || row.dataset.status === status;
        const matchesAction = !action || (row.dataset.action || '').toLowerCase().includes(action);
        const entry = timeline.find((item) => item.index === Number(row.dataset.index));
        const searchable = JSON.stringify({
          action: entry?.actionType,
          status: entry?.status,
          url: entry?.postUrl,
          hash: entry?.postDomHash,
          target: entry?.target,
          control: entry?.control
        }).toLowerCase();
        const matchesText = !text || searchable.includes(text);
        const visible = matchesStatus && matchesAction && matchesText;
        row.style.display = visible ? '' : 'none';

        if (visible) {
          const statusKey = row.dataset.status || '(unknown)';
          const actionKey = row.dataset.action || '(unknown)';
          statusCounts.set(statusKey, (statusCounts.get(statusKey) || 0) + 1);
          actionCounts.set(actionKey, (actionCounts.get(actionKey) || 0) + 1);
          if (firstVisible === null) {
            firstVisible = Number(row.dataset.index);
          }
        }

        const preview = row.nextElementSibling;
        if (preview && preview.classList.contains('preview-row')) {
          preview.style.display = visible ? '' : 'none';
        }
      }

      updateSummary(statusSummary, statusCounts);
      updateSummary(actionSummary, actionCounts);

      if (selectedIndex === null || !rows.some((row) => Number(row.dataset.index) === selectedIndex && row.style.display !== 'none')) {
        if (firstVisible !== null) {
          showEntry(firstVisible);
        } else {
          selectedIndex = null;
          detailsPane.textContent = 'No rows match current filters.';
        }
      }
    }

    statusFilter.addEventListener('change', applyFilters);
    actionFilter.addEventListener('input', applyFilters);
    textFilter.addEventListener('input', applyFilters);

    applyFilters();
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

function safeJsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}
