# Sazen

The agent first broswer.

```text
  ____    _    ______ _____ _   _
 / ___|  / \  |__  / | ____| \ | |
 \___ \ / _ \   / /  |  _| |  \| |
  ___) / ___ \ / /_  | |___| |\  |
 |____/_/   \_/____| |_____|_| \_|
```

Sazen is an agent-first Chromium runtime for deterministic browser automation.

It is designed for two audiences at the same time:
- agents that need typed, replayable browser actions
- humans who need clear visibility, diagnostics, and artifacts when runs fail

The runtime executes atomic actions, captures structured state after each action, and writes trace artifacts that can be replayed, diffed, and triaged.

## Project Scope

Sazen combines:
- deterministic execution controls (stability profiles, replay checks, bounded retries)
- structured page state (semantic snapshots, DOM hash/diff metadata, event streams)
- rich diagnostics (timeline, HTML timeline, visual diff overlays, triage bundles)
- long-run controls (pause/resume, checkpoint/resume, intervention journaling)
- adapter surfaces for external agent runtimes (stdio aliases and local HTTP service)

## Install

Requirements:
- Node.js 20+

Recommended (one-line installer):

```bash
curl -fsSL https://raw.githubusercontent.com/Soyuz0/sazen/master/scripts/install.sh | bash
```

The installer supports Linux, macOS, and Windows bash environments (Git Bash/WSL).

Installer options:

```bash
# install a specific release tag or branch
curl -fsSL https://raw.githubusercontent.com/Soyuz0/sazen/master/scripts/install.sh | bash -s -- --version v0.1.0

# skip PATH edits
curl -fsSL https://raw.githubusercontent.com/Soyuz0/sazen/master/scripts/install.sh | bash -s -- --no-modify-path

# skip browser install (run playwright install later)
curl -fsSL https://raw.githubusercontent.com/Soyuz0/sazen/master/scripts/install.sh | bash -s -- --skip-browser-install
```

Manual setup (from source checkout):

```bash
npm install
npm run install:browser
npm run build
```

## Quick Start

1) Start the local fixture app:

```bash
npm run fixture
```

2) Run a scripted flow and save a trace:

```bash
npm run dev -- run examples/sample-flow.json --headless --trace traces/sample-trace.json --live-timeline
```

3) Triage and verify:

```bash
npm run dev -- replay traces/sample-trace.json --mode relaxed
npm run dev -- timeline traces/sample-trace.json --artifacts
npm run dev -- timeline-html traces/sample-trace.json
npm run dev -- bundle traces/sample-trace.json --copy-artifacts
```

4) Run cross-site smoke validation:

```bash
npm run smoke:sites -- --operation-timeout-ms 60000 --action-timeout-ms 30000 --stability-profile balanced
```

## CLI Overview

Core browser/session commands:
- `open <url>`: open URL and stream runtime events
- `inspect <url>`: print interactive node map
- `describe <url>`: emit agent-oriented page description
- `snapshot <url>`: emit token-optimized snapshot JSON
- `load <session-name>`: restore a saved session and keep browser open
- `profile-save <name> <url>` / `profile-load <name>`: reusable authenticated profiles

Execution commands:
- `run <script.json>`: execute a JSON action script
- `loop <loop.json>`: run action -> observe -> branch iterations
- `act <json|@file>`: run one action or a small action list quickly
- `run-control pause|resume|state --socket <path>`: control long running `run` sessions

Replay and diagnostics:
- `replay <trace>`: strict or relaxed deterministic replay
- `flake <trace>`: repeated replay instability analysis
- `timeline <trace>`: terminal timeline view
- `timeline-html <trace>`: searchable HTML timeline report
- `visual-diff <baselineTrace> <candidateTrace>`: screenshot diff overlays
- `bundle <trace>`: packaged triage output
- `selector-health <trace>`: target reliability hotspot report
- `run-index <trace>`: canonical run artifact index
- `drift-monitor [history.json]`: recurring drift signatures and recommendations

## Action Model

Scripts are JSON documents with optional `settings` and ordered `actions`.

```json
{
  "settings": {
    "headed": false,
    "deterministic": true,
    "stabilityProfile": "balanced",
    "maxActionAttempts": 3,
    "retryBackoffMs": 150
  },
  "actions": [
    { "type": "navigate", "url": "http://127.0.0.1:4173" },
    { "type": "fill", "target": { "kind": "css", "selector": "#email" }, "value": "agent@example.com" },
    { "type": "click", "target": { "kind": "roleName", "role": "button", "name": "Sign in" } },
    { "type": "waitFor", "condition": { "kind": "network_response", "urlContains": "/api/session", "statusMin": 200, "statusMax": 299 } },
    { "type": "assert", "condition": { "kind": "selector", "selector": "#status", "textContains": "Welcome" } },
    { "type": "checkpoint", "name": "after-login" },
    { "type": "snapshot" }
  ]
}
```

Common action families:
- navigation and input: `navigate`, `click`, `fill`, `select`, `press`
- synchronization and checks: `waitFor`, `assert`, `snapshot`
- long-run resilience: `pause`, `checkpoint`, `switchProfile`
- built-in helpers: `handleConsent`, `handleLogin`

## Determinism and Reliability

- Deterministic mode is the default and should be kept on for reproducibility.
- Stability profiles (`fast`, `balanced`, `chatty`) tune wait behavior for site noise.
- Auto-retry is bounded by `maxActionAttempts` and captures per-attempt evidence.
- Replays support:
  - `strict` mode for deterministic fixtures
  - `relaxed` mode for dynamic public pages with selector invariants
- Long scripts can resume safely with `checkpoint` + `run --resume-from-checkpoint`.
- Intervention history is retained in traces with optional caps, severity mode, and per-source quotas.

## Adapter Surfaces

All adapters sit on the same runtime contract (`src/sdk-contract.ts`) and expose `ping.sdkContractVersion` for compatibility checks.

Shared session identity fields:
- `adapterSessionId`: external adapter handle used in requests
- `runtimeSessionId`: underlying runtime session id
- `runtimeTabId`: runtime tab id

Adapter commands:
- `adapter-stdio`: base line-delimited JSON transport (`ping`, `createSession`, `performAction`, `runActions`, `pauseSession`, etc.)
- `adapter-opencode`: OpenCode aliases (`oc.*`) mapped to the same contract
- `adapter-claude`: Claude Code aliases (`cc.*`) plus slash command dispatch (`cc.command` + `/browser/...`)
- `adapter-codex`: local HTTP service for Codex flows

Codex HTTP endpoints:
- `GET /v1/health`
- `POST /v1/action`, `POST /v1/run`
- `POST /v1/replay`, `POST /v1/timeline`
- `POST /v1/session/create|close|pause|resume|state|snapshot|describe|save-trace|save-session`
- `POST /v1/adapter` for raw passthrough adapter requests

## Artifacts and Output Layout

- `traces/`: saved run traces
- `reports/runtime-logs/`: runtime logs and optional timeline streams
- `reports/site-matrix-summary.json`: smoke matrix summary
- `reports/drift-monitor/`: drift history, aggregate, recommendations
- `reports/timeline-html/`: HTML timeline reports
- `reports/visual-diff/`: visual diff output
- `reports/triage-bundles/`: bundle artifacts
- `.sazen/artifacts/`: screenshots and per-action files
- `.sazen/context/`: latest screenshot handoff (`latest.json`, `attachments.jsonl`)
- `.sazen/sessions/` and `.sazen/profiles/`: persisted state

## Validation and Development

Standard development validation:

```bash
npm run typecheck
npm test
npm run build
npm run smoke:sites -- --operation-timeout-ms 60000 --action-timeout-ms 30000 --stability-profile balanced
```

## Related Docs

- `SAZEN_SKILL.md`: concise operations playbook for autonomous agents
- `agents.md`: execution rules for agent behavior and repo workflow
- `.plan`: current roadmap, completed milestones, and future priorities
