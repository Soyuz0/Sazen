# Agent Browser

Agent Browser is an **agent-first Chromium runtime** for deterministic web testing.

In one line: it lets an autonomous agent act in a browser with structured, replayable state (DOM diffs, logs, network, screenshots, timeline, visual diffs), while humans can still watch/debug what happened.

## Quick Start

```bash
npm install
npm run install:browser

# local fixture app
npm run fixture

# run scripted flow headless and save trace
npm run dev -- run examples/sample-flow.json --headless --trace traces/sample-trace.json

# stream live timeline rows while run executes
npm run dev -- run examples/sample-flow.json --headless --live-timeline --timeline-stream reports/runtime-logs/live.jsonl

# replay, inspect timeline, and build triage bundle
npm run dev -- replay traces/sample-trace.json --mode relaxed
npm run dev -- timeline traces/sample-trace.json --artifacts
npm run dev -- bundle traces/sample-trace.json --copy-artifacts
```

---

## What This Project Does

### For agents
- Executes atomic actions (`navigate`, `click`, `fill`, `assert`, `handleConsent`, etc.).
- Returns structured post-action output (status, DOM diff, events, timings, screenshots).
- Supports deterministic replay (`strict` and `relaxed` modes) and flake detection.

### For humans
- Can run headed and watch the page live.
- Can inspect post-run timeline (terminal table, HTML report, bundles).
- Can compare visual changes between runs (diff overlays).

### For teams
- Produces reproducible artifacts under repo paths (`traces/`, `reports/`, `.agent-browser/`).
- Supports cross-site smoke batches with timeout guards.
- Supports profile save/load for reusable authenticated sessions.

---

## Installation

### Requirements
- Node.js 20+
- Linux/macOS/Windows with Chromium deps for Playwright

### Setup

```bash
npm install
npm run install:browser
```

---

## Core Concepts

### 1) Atomic action model
Every step is a typed action and returns a typed result envelope.

### 2) Structured state over pixels
The runtime captures semantic DOM snapshots, diffs, and event streams.

### 3) Deterministic-first execution
Supports reduced motion, deterministic timing/random behavior, replay checks, and stable wait profiles.

### 4) Artifact-rich debugging
Each action can emit screenshots (and annotated overlays), logs, network events, timeline entries, and diff metadata.

---

## Commands

### Browser/session commands
- `open <url>`: open URL and stream live events.
- `inspect <url>`: print interactive node map.
- `describe <url>`: emit agent-oriented page description JSON.
- `load <sessionName>`: load saved session and keep running.
- `profile-save <name> <url>`: save reusable profile session.
- `profile-load <name>`: load reusable profile.

### Execution commands
- `run <script.json>`: execute action script.
- `act <json|@file>`: execute one or many actions.
- `snapshot <url>`: print token-optimized snapshot JSON.

### Replay and diagnostics
- `replay <trace>`: deterministic replay (strict/relaxed).
- `flake <trace>`: repeated replay mismatch analysis.
- `timeline <trace>`: terminal timeline view.
- `timeline-html <trace>`: interactive HTML timeline report.
- `bundle <trace>`: triage bundle (trace + manifest + artifacts refs).
- `visual-diff <baselineTrace> <candidateTrace>`: screenshot diff overlays.

### Batch validation
- `npm run smoke:sites`: cross-site smoke matrix runner.

---

## Action Script Format

Action scripts are JSON with optional `settings` + ordered `actions`.

```json
{
  "settings": {
    "headed": false,
    "deterministic": true,
    "stabilityProfile": "balanced",
    "captureScreenshots": true,
    "screenshotMode": "viewport"
  },
  "actions": [
    { "type": "setViewport", "width": 1366, "height": 768 },
    { "type": "navigate", "url": "http://localhost:4173" },
    { "type": "fill", "target": { "kind": "css", "selector": "#email" }, "value": "a@b.com" },
    { "type": "click", "target": { "kind": "roleName", "role": "button", "name": "Sign in" } },
    {
      "type": "assert",
      "condition": { "kind": "selector", "selector": "#status", "textContains": "Welcome" }
    },
    { "type": "snapshot" }
  ]
}
```

### Assertion conditions
- `selector` (state + optional textContains)
- `selector_bbox_min` (min width/height)
- `selector_overlap_max` (max overlap ratio between two selectors)
- `url_contains`
- `title_contains`

### Consent helper

```json
{ "type": "handleConsent", "mode": "accept", "requireFound": true }
```

---

## Runtime/CLI Configuration

Common options (available on most execution commands):

- `--headless`
- `--no-deterministic`
- `--slowmo <ms>`
- `--stability-profile fast|balanced|chatty`
- `--viewport WIDTHxHEIGHT`
- `--screenshot-mode viewport|fullpage`
- `--no-annotate-screenshots`
- `--redaction-pack default|strict|off`
- `--raw-logs`

### Stability profiles
- `fast`: smaller stability windows, quickest runs.
- `balanced`: default general-purpose profile.
- `chatty`: larger waits for streaming/noisy sites.

### Screenshot behavior
- `viewport` (default): less rendering churn/flicker.
- `fullpage`: full-page capture; heavier and may trigger more reflow work.
- Annotated screenshots are enabled by default and mark target location for action steps when resolvable.
- Use `--no-annotate-screenshots` to disable per-action overlay markers.

### Redaction packs
- `default`: masks common secrets (tokens/passwords/auth headers).
- `strict`: stronger masking (cookies/API keys/emails).
- `off`: no built-in redaction.

---

## Artifacts and Output Layout

- `traces/`: saved trace files.
- `reports/runtime-logs/`: command logs.
- `reports/runtime-logs/*.jsonl`: optional live timeline streams from `run --timeline-stream`.
- `reports/site-matrix-summary.json`: matrix summary.
- `reports/timeline-html/`: timeline HTML reports.
- `reports/visual-diff/`: visual diff images/reports.
- `reports/triage-bundles/`: packaged triage outputs.
- `.agent-browser/artifacts/`: screenshots and action artifacts.
- `.agent-browser/sessions/`: saved sessions.
- `.agent-browser/profiles/`: saved profiles.

---

## Practical Workflows

### Local website debugging with an agent
1. Run app locally.
2. Execute flow script with `run`.
3. Use `describe` to inspect semantic+positional state.
4. Use `timeline` / `timeline-html` / `bundle` for root cause.

### Regression gate
1. Capture baseline trace.
2. Capture candidate trace.
3. Run `replay` and `visual-diff`.
4. Fail CI when mismatch exceeds threshold.

### Flaky test analysis
1. Run `flake` on a trace.
2. Inspect unstable actions.
3. Re-run with `stability-profile chatty` and compare.

---

## Examples

- Local fixture login flow: `examples/sample-flow.json`
- Consent wall flow: `examples/consent-flow.json`
- Public multi-site flows: `examples/site-flows/*.json`

---

## Testing

```bash
npm run typecheck
npm test
npm run build

# cross-site smoke batch (timeout guarded)
npm run smoke:sites -- --operation-timeout-ms 60000 --action-timeout-ms 30000 --stability-profile balanced
```

---

## Current Scope vs Planned

Implemented now:
- action runtime + structured snapshots/diffs/events
- replay/flake/timeline/timeline-html/bundle/visual-diff
- assertion DSL, consent helper, profiles, stability modes
- annotated per-action screenshots

Planned (tracked in `.plan`):
- live timeline pane during active execution (not only post-run report)
- element-aware visual diff labels/boxes
- pause/resume with intervention journaling
- first-class integrations for OpenCode, Claude Code, OpenAI Codex
