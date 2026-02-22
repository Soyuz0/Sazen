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

# start a controllable run (from another shell use run-control)
npm run dev -- run examples/sample-flow.json --headless --control-socket reports/runtime-logs/run-control.sock
npm run dev -- run-control state --socket reports/runtime-logs/run-control.sock
npm run dev -- run-control pause --socket reports/runtime-logs/run-control.sock
npm run dev -- run-control resume --socket reports/runtime-logs/run-control.sock

# resume from a previously recorded checkpoint
npm run dev -- run examples/sample-flow.json --resume-from-checkpoint after-login

# pause during a script step (timeout mode example inside script)
# { "type": "pause", "mode": "timeout", "timeoutMs": 5000, "note": "manual review" }

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
- Auto-publishes latest screenshot artifacts into `.agent-browser/context/` for feedback-loop consumption.

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
- `loop <loop.json>`: execute action -> observe -> branch loop script.
- `run-control <command>`: send `pause|resume|state` to a running script via control socket.
- `act <json|@file>`: execute one or many actions.
- `snapshot <url>`: print token-optimized snapshot JSON.

`run` live timeline modes:
- `--live-timeline --live-timeline-mode row` (default)
- `--live-timeline --live-timeline-mode tui` (interactive terminal pane)

When `run` or `loop` saves a trace (`--trace`), companion outputs are generated automatically:
- `reports/selector-health/<trace>.selector-health.json`
- `reports/run-index/<trace>.run-index.json`

### Replay and diagnostics
- `replay <trace>`: deterministic replay (strict/relaxed).
- `flake <trace>`: repeated replay mismatch analysis.
- `timeline <trace>`: terminal timeline view.
- `timeline-html <trace>`: interactive HTML timeline inspector (grouping, search, presets, diff-only focus, detail pane).
- `bundle <trace>`: triage bundle (trace + manifest + artifacts refs).
- `visual-diff <baselineTrace> <candidateTrace>`: screenshot diff overlays.
- `selector-health <trace>`: selector fragility report (fallback/ambiguity/timeout hotspots).
- `run-index <trace>`: canonical run artifact index for external ingestion.
- `drift-monitor [history.json]`: recurring cross-run drift signatures + recommendation report.

### External agent adapter
- `adapter-stdio`: line-delimited JSON adapter server over stdio for coding agents and tool runners.
- Methods include session lifecycle, action execution, and run controls (`pauseSession`, `resumeSession`, `getSessionState`).
- MCP-parity aliases are available (`session.pause`, `session.resume`, `session.state`).
- Session identity fields are explicit in adapter responses:
  - `adapterSessionId`: adapter-facing handle used in method params.
  - `runtimeSessionId`: underlying browser runtime session identifier.
  - `runtimeTabId`: runtime tab identifier (currently `tab_1`).
- Backward compatibility: action results still include `sessionId`, which equals `runtimeSessionId`.

### Agent skill doc
- `AGENT_BROWSER_SKILL.md`: load this into agent contexts as the runtime usage playbook.

### Batch validation
- `npm run smoke:sites`: cross-site smoke matrix runner.
- Smoke runs also append drift-monitor history and aggregate outputs under `reports/drift-monitor/`.

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
    "screenshotMode": "viewport",
    "maxInterventionsRetained": 100,
    "interventionRetentionMode": "severity",
    "interventionSourceQuotas": { "overlay": 2, "cli": 1 },
    "maxActionAttempts": 3,
    "retryBackoffMs": 150
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
    {
      "type": "switchProfile",
      "profile": "admin",
      "profilesRoot": ".agent-browser/profiles"
    },
    { "type": "checkpoint", "name": "after-admin-login" },
    { "type": "snapshot" }
  ]
}
```

### Trace-scoped profile switching

```json
{
  "type": "switchProfile",
  "profile": "admin",
  "profilesRoot": ".agent-browser/profiles",
  "waitUntil": "domcontentloaded"
}
```

- `switchProfile` loads a saved profile session inside the current run trace.
- This enables role transitions (for example, user -> admin) without ending the run.
- Defaults to the saved profile URL from the profile manifest unless `url` is provided.

### Assertion conditions
- `selector` (state + optional textContains)
- `selector_bbox_min` (min width/height)
- `selector_overlap_max` (max overlap ratio between two selectors)
- `visual_baseline` (compare current screenshot to baseline image)
- `url_contains`
- `title_contains`

### waitFor conditions
- `timeout` (fixed sleep)
- `selector` (attached/detached/visible/hidden)
- `network_idle` (page idle)
- `network_response` (wait for response matching URL/method/status/body predicates)

Network-aware wait example:

```json
{
  "type": "waitFor",
  "condition": {
    "kind": "network_response",
    "urlContains": "/api/status",
    "method": "GET",
    "statusMin": 200,
    "statusMax": 299,
    "bodyIncludes": "ready"
  }
}
```

### Auto-retry policy
- `settings.maxActionAttempts` controls bounded retries for retryable failures (`timeout`, transient navigation/network races).
- `settings.retryBackoffMs` adds delay between retry attempts.
- Per-attempt evidence is captured in action results (`result.retry.attempts[]`) and persisted in trace records/timeline metadata.
- Retries only re-run `retryable_error` attempts; `fatal_error` exits immediately with `finalReason=non_retryable_error`.

Visual baseline assert example:

```json
{
  "type": "assert",
  "condition": {
    "kind": "visual_baseline",
    "baselinePath": "reports/baselines/home.png",
    "maxMismatchRatio": 0.01,
    "threshold": 0.1
  }
}
```

### Pause action
- `pause` lets the run pause for manual review and then resume.
- Modes:
  - `timeout`: resume after `timeoutMs`
  - `enter`: wait for Enter (or timeout fallback)
- Result metadata includes `pauseSummary` with elapsed time and whether URL/DOM changed during pause.

### Checkpoint action + resume flow

```json
{
  "type": "checkpoint",
  "name": "after-login",
  "rootDir": ".agent-browser/checkpoints"
}
```

- `checkpoint` persists a named session manifest (URL + storage state) for long-run recovery.
- `run --resume-from-checkpoint <name>` restores that checkpoint and continues with remaining actions.
- Resume safety: checkpoint manifests are tied to a script content hash and fail fast if the script changed.

### Loop script format

Loop scripts support repeated **action -> observe -> branch** execution with optional max iteration limits.

```json
{
  "settings": {
    "headed": false,
    "deterministic": true
  },
  "setupActions": [
    { "type": "navigate", "url": "http://127.0.0.1:4173/loop.html" }
  ],
  "stepAction": {
    "type": "click",
    "target": { "kind": "css", "selector": "#increment" }
  },
  "maxIterations": 6,
  "branches": [
    {
      "label": "done",
      "when": [
        {
          "kind": "assert",
          "condition": { "kind": "selector", "selector": "#status", "textContains": "done" }
        }
      ],
      "next": "break"
    },
    {
      "label": "keep-going",
      "next": "continue"
    }
  ]
}
```

- Predicate kinds:
  - `assert`: reuses existing assert conditions (`selector`, `url_contains`, etc.)
  - `snapshot`: evaluate snapshot fields (`url`, `title`, `domHash`, `nodeCount`, `interactiveCount`)
- Branches are evaluated in order; first match wins.
- `next`: `continue` (default) or `break`.

### Run-level control + provenance
- `run --control-socket <path>` starts a local control socket for external pause/resume/state commands.
- `run-control pause|resume|state --socket <path>` controls or inspects an active run from another terminal.
- Trace output now includes:
  - `timeline` provenance markers: `pause_start`, `pause_resume`
  - `interventions` journal entries (pre/post URL + DOM hash, storage deltas, reconciliation hints)
- Optional retention policy: set `maxInterventionsRetained` (script/adapter) or `--max-interventions-retained` (`run`/`loop`) to cap kept intervention journal entries.
- Retention mode:
  - `count` (default): trim oldest entries first.
  - `severity`: trim low-impact entries first, preserving URL/DOM/storage-changing interventions when possible.
- Per-source quotas:
  - `interventionSourceQuotas` (script/adapter) or `--intervention-source-quotas overlay=1,cli=1`
  - quota-protected sources are preferentially retained when trimming under cap.

### Browser overlay controls
- By default, pages include a small top-right runtime panel with `Pause` and `Resume`.
- Overlay pause blocks the next automated action until resumed.
- Overlay elements are excluded from DOM snapshots/diffs so runtime controls do not pollute hashes.

### Consent helper

```json
{
  "type": "handleConsent",
  "mode": "accept",
  "strategy": "auto",
  "region": "eu",
  "siteAdapter": "github.com",
  "requireFound": true
}
```

- `strategy`: `auto` (CMP+site+generic), `cmp`, or `generic`.
- `region`: `auto`, `global`, `eu`, `us`, `uk`.
- `siteAdapter`: optional hostname hint for site-specific selectors.

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

`run`/`loop` additional option:
- `--max-interventions-retained <n>`
- `--intervention-retention-mode count|severity`
- `--intervention-source-quotas <source=n,...>`
- `--max-action-attempts <n>`
- `--retry-backoff-ms <n>`
- `--resume-from-checkpoint <name>`
- `--checkpoint-manifest <path>`

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
- `reports/drift-monitor/history.json`: accumulated cross-run drift history.
- `reports/drift-monitor/aggregate.json`: recurring failure signature + site failure-rate aggregate.
- `reports/drift-monitor/recommendations.json`: ranked drift recommendations.
- `reports/timeline-html/`: timeline HTML reports.
- `reports/visual-diff/`: visual diff images/reports.
- `reports/triage-bundles/`: packaged triage outputs.
- `.agent-browser/artifacts/`: screenshots and action artifacts.
- `.agent-browser/context/`: latest screenshot attachment handoff (`latest.json`, `attachments.jsonl`, `latest.png`).
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

### Integrating from another agent runtime
1. Start adapter server:

```bash
npm run dev -- adapter-stdio
```

2. Send JSON requests line-by-line on stdin:

```json
{"id":1,"method":"ping"}
{"id":2,"method":"createSession","params":{"options":{"headed":false,"deterministic":true}}}
{"id":3,"method":"performAction","params":{"sessionId":"<session-id>","action":{"type":"navigate","url":"http://localhost:3000"}}}
{"id":4,"method":"describe","params":{"sessionId":"<session-id>","maxElements":80}}
{"id":5,"method":"pauseSession","params":{"sessionId":"<session-id>"}}
{"id":6,"method":"getSessionState","params":{"sessionId":"<session-id>"}}
{"id":7,"method":"resumeSession","params":{"sessionId":"<session-id>"}}
{"id":8,"method":"closeSession","params":{"sessionId":"<session-id>"}}
```

3. Read line-delimited JSON responses (`ok`, `result`, `error`); responses may arrive out of order, so correlate by `id`.

### Controlling a long local run
1. Start run with control socket:

```bash
npm run dev -- run examples/sample-flow.json --control-socket reports/runtime-logs/run-control.sock
```

2. From another shell:

```bash
npm run dev -- run-control state --socket reports/runtime-logs/run-control.sock
npm run dev -- run-control pause --socket reports/runtime-logs/run-control.sock
npm run dev -- run-control resume --socket reports/runtime-logs/run-control.sock
```

---

## Examples

- Local fixture login flow: `examples/sample-flow.json`
- Consent wall flow: `examples/consent-flow.json`
- Loop runner flow: `examples/loop-flow.json`
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
- loop runtime (action -> observe -> branch)
- replay/flake/timeline/timeline-html/bundle/visual-diff
- assertion DSL, consent helper, profiles, stability modes
- annotated per-action screenshots
- run-level pause/resume controls with trace intervention journaling and provenance markers
- trace-scoped role switching, visual baseline assert, live timeline TUI, selector health + run index
- network-aware wait primitives via `waitFor.condition.kind = network_response`
- bounded action auto-retry policy with per-attempt evidence + final rationale in traces
- cross-run drift monitor aggregation and recommendation reporting

Planned (tracked in `.plan`):
- consent/login plugin registry
- dedicated first-class adapters for OpenCode, Claude Code, OpenAI Codex on top of adapter-stdio
