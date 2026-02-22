# Sazen Skill (Complete Operations Guide)

Load this skill whenever an agent needs to drive browsers in this repository.

This guide is intentionally detailed. It covers:
- all CLI commands
- command options and when to use them
- full action and loop script schemas
- adapter protocols (stdio, OpenCode, Claude, Codex HTTP)
- artifact outputs and diagnostics workflows
- how to explain results and next steps to humans

Use this as the working playbook for autonomous execution.

## 1) What Sazen Is

Sazen is an agent-first Chromium runtime that executes typed actions and returns structured evidence for every step.

Core capabilities:
- deterministic execution controls for reproducibility
- atomic action model with structured result envelopes
- semantic snapshots and DOM hash/diff tracking
- replay and flake analysis
- timeline, visual diff, selector health, drift monitoring
- pause/resume controls, checkpoint/resume, intervention journaling
- adapter surfaces for other agent runtimes

## 2) Mental Model

Think in this pipeline:

1. Start a browser session with options (headless/headed, stability profile, viewport, etc.).
2. Execute atomic actions (`navigate`, `click`, `waitFor`, `assert`, etc.).
3. Capture action result evidence (status, snapshots, diff, logs, perf, screenshots).
4. Save trace and run diagnostics (`replay`, `flake`, `timeline`, `bundle`, `visual-diff`).
5. Report outcomes to humans with artifact paths and concrete next actions.

## 3) Fast Start (Recommended Default Workflow)

```bash
npm run build
npm test

# optional local test app
npm run fixture

# execute scripted run
npm run dev -- run examples/sample-flow.json --headless --trace traces/sample-trace.json --live-timeline

# inspect outcomes, failures, or stability
npm run dev -- replay traces/sample-trace.json --mode relaxed
npm run dev -- timeline traces/sample-trace.json --artifacts
npm run dev -- timeline-html traces/sample-trace.json
npm run dev -- bundle traces/sample-trace.json --copy-artifacts
```

For unattended cross-site validation:

```bash
npm run smoke:sites -- --operation-timeout-ms 60000 --action-timeout-ms 30000 --stability-profile balanced
```

## 4) Command Reference (Complete)

Important: command help is the runtime source of truth for current flags.

```bash
node dist/cli.js --help
node dist/cli.js <command> --help
```

### 4.1 Shared runtime option concepts

Many commands reuse these options:
- `--headless`: run Chromium headless (default false for many interactive commands)
- `--no-deterministic`: disable deterministic mode
- `--slowmo <ms>`: Playwright slow motion delay
- `--stability-profile <profile>`: `fast|balanced|chatty`
- `--viewport <WxH>`: viewport size like `1366x768`
- `--screenshot-mode <mode>`: `viewport|fullpage`
- `--no-annotate-screenshots`: disable target overlays on screenshots (when supported)
- `--redaction-pack <pack>`: `default|strict|off`
- `--raw-logs`: disable log noise filtering

### 4.2 Browser/session commands

`open <url>`
- Purpose: open URL and stream real-time events
- Extra option: `--save <name>` save session on exit

`inspect <url>`
- Purpose: navigate and print interactive node map
- Extra option: `--limit <n>` maximum rows (default 40)

`snapshot <url>`
- Purpose: print token-optimized snapshot JSON

`describe <url>`
- Purpose: print agent-oriented page description JSON
- Extra option: `--max-elements <n>` (default 80)

`profile-save <name> <url>`
- Purpose: manual login flow then save reusable profile
- Extra options:
  - `--profiles-root <path>` (default `.sazen/profiles`)
  - `--auto-save-ms <ms>` auto-save timer

`profile-load <name>`
- Purpose: load profile and keep browser open
- Extra options:
  - `--profiles-root <path>`
  - `--close-after-ms <ms>` auto-close timer

`load <name>`
- Purpose: load saved session and keep browser open
- Extra option: `--sessions-root <path>` (default `.sazen/sessions`)

### 4.3 Execution commands

`run <scriptPath>`
- Purpose: execute a JSON action script
- Extra options:
  - `--trace <path>` write trace file
  - `--save <name>` save session on completion
  - `--logs` print captured events after each action
  - `--live-timeline`
  - `--live-timeline-mode <mode>`: `row|tui`
  - `--timeline-stream <path>` write JSONL timeline stream
  - `--control-socket <path>` enable run-control socket
  - `--resume-from-checkpoint <name>` continue from checkpoint
  - `--checkpoint-manifest <path>` explicit checkpoint manifest path
  - `--max-interventions-retained <n>`
  - `--intervention-retention-mode <mode>`: `count|severity`
  - `--intervention-source-quotas <spec>` (example `overlay=1,cli=1`)
  - `--max-action-attempts <n>`
  - `--retry-backoff-ms <n>`

`loop <loopPath>`
- Purpose: iterative action -> observe -> branch execution
- Extra options:
  - `--trace <path>`
  - `--save <name>`
  - `--logs` print loop action events
  - `--max-iterations <n>` override script max iterations
  - `--loop-metrics-out <path>` write loop KPI sidecar JSON
  - `--loop-log-every <n>` print detailed rows every N iterations
  - `--loop-summary-only` print compact summaries only
  - `--loop-log-branches-only-on-change` print branch details only when outcomes change
  - same intervention/retry flags as `run`

`act <action>`
- Purpose: run one action or action array quickly (`inline JSON` or `@file.json`)
- Extra options:
  - `--url <url>` pre-navigation
  - `--logs` print events (default true)

`run-control <command>`
- Purpose: control a running `run` process over socket
- Commands: `pause|resume|state`
- Options:
  - `--socket <path>` required socket path
  - `--timeout <ms>` request timeout (default 5000)
  - `--wait-for-socket-ms <ms>` wait for control socket readiness before sending
  - `--json` print raw response

### 4.4 Replay and diagnostics commands

`replay <tracePath>`
- Purpose: replay trace and compare invariants/hashes
- Options:
  - `--mode <mode>`: `strict|relaxed`
  - `--preflight-timeout <ms>` per-origin preflight timeout
  - `--no-preflight`
  - `--no-selector-invariants` (relaxed mode)
  - plus shared runtime options

`flake <tracePath>`
- Purpose: run replay repeatedly to detect unstable actions
- Options:
  - `--runs <n>`
  - `--mode <mode>`
  - `--preflight-timeout <ms>`
  - `--no-preflight`
  - `--no-selector-invariants`
  - plus shared runtime options

`timeline <tracePath>`
- Purpose: action timeline in terminal or JSON
- Options:
  - `--limit <n>` (default 200)
  - `--status <status>`
  - `--action <type>`
  - `--artifacts`
  - `--annotated-artifacts`
  - `--json`

`timeline-html <tracePath>`
- Purpose: interactive HTML timeline report
- Options:
  - `--out <dir>` (default `reports/timeline-html`)
  - `--limit <n>`
  - `--title <text>`

`bundle <tracePath>`
- Purpose: create triage bundle from trace
- Options:
  - `--out <dir>` (default `reports/triage-bundles`)
  - `--copy-artifacts`

`visual-diff <baselineTrace> <candidateTrace>`
- Purpose: compare screenshot steps and generate diffs
- Options:
  - `--out <dir>`
  - `--threshold <n>` pixelmatch threshold
  - `--fail-ratio <n>` failure gate ratio
  - `--max-steps <n>`
  - `--annotated`
  - `--json`
  - `--no-write-diffs`

`selector-health <tracePath>`
- Purpose: selector fragility report from trace
- Options:
  - `--out <path>`
  - `--max-ambiguity-rate <n>` fail when ambiguity rate exceeds threshold
  - `--max-fallback-rate <n>` fail when fallback usage rate exceeds threshold
  - `--json`

`context-peek`
- Purpose: show latest screenshot context metadata for action->feedback loops
- Options:
  - `--context-dir <path>` (default `.sazen/context`)
  - `--json`

`run-index <tracePath>`
- Purpose: canonical artifact index for integrations
- Options:
  - `--out <path>`
  - `--json`

`drift-monitor [historyPath]`
- Purpose: recurring cross-run drift signatures and recommendations
- Options:
  - `--aggregate <path>`
  - `--out <path>`
  - `--min-occurrences <n>`
  - `--top <n>`
  - `--json`

### 4.5 Adapter commands

`adapter-stdio`
- Purpose: base line-delimited JSON adapter server

`adapter-opencode`
- Purpose: OpenCode alias bridge (`oc.*`)

`adapter-claude`
- Purpose: Claude alias bridge (`cc.*`) and slash command mapping

`adapter-codex`
- Purpose: local HTTP adapter service
- Options:
  - `--host <host>` (default `127.0.0.1`)
  - `--port <port>` (default `4242`)

## 5) Action Script Schema (Complete)

Action script format:

```json
{
  "settings": { "deterministic": true },
  "actions": [
    { "type": "navigate", "url": "http://127.0.0.1:4173" },
    { "type": "snapshot" }
  ]
}
```

### 5.1 `settings` fields

`settings` supports:
- `headed?: boolean`
- `browserOverlay?: boolean`
- `deterministic?: boolean`
- `slowMoMs?: number`
- `stabilityProfile?: "fast" | "balanced" | "chatty"`
- `screenshotMode?: "viewport" | "fullpage"`
- `annotateScreenshots?: boolean`
- `redactionPack?: "default" | "strict" | "off"`
- `viewportWidth?: number`
- `viewportHeight?: number`
- `actionTimeoutMs?: number`
- `stableWaitMs?: number`
- `captureScreenshots?: boolean`
- `artifactsDir?: string`
- `contextAttachments?: boolean`
- `contextAttachmentsDir?: string`
- `maxInterventionsRetained?: number`
- `interventionRetentionMode?: "count" | "severity"`
- `interventionSourceQuotas?: Record<string, number>`
- `maxActionAttempts?: number`
- `retryBackoffMs?: number`
- `storageStatePath?: string`
- `logNoiseFiltering?: boolean`

### 5.2 Target schema (`nodeId` / `target`)

For `click`, `fill`, and `select`, either `nodeId` or `target` is required.

`target.kind` values:
- `node`: `{ "kind": "node", "nodeId": "..." }`
- `stableRef`: `{ "kind": "stableRef", "value": "..." }`
- `roleName`: `{ "kind": "roleName", "role": "button", "name": "Submit" }`
- `css`: `{ "kind": "css", "selector": "#submit" }`

### 5.3 Action types and fields

`navigate`
- `url` (required)
- `waitUntil?: "load" | "domcontentloaded" | "networkidle"`
- `timeoutMs?`

`click`
- `nodeId?` or `target?` (required one of them)
- `timeoutMs?`

`fill`
- `value` (required)
- `nodeId?` or `target?`
- `timeoutMs?`

`select`
- `value` (required)
- `nodeId?` or `target?`
- `timeoutMs?`

`press`
- `key` (required)
- `timeoutMs?`

`pause`
- `mode?: "enter" | "timeout"`
- `timeoutMs?`
- `note?`

`assert`
- `condition` (required; see condition kinds below)
- `timeoutMs?`

`handleConsent`
- `mode?: "accept" | "reject"`
- `requireFound?`
- `strategy?: "auto" | "generic" | "cmp"`
- `siteAdapter?`
- `region?: "auto" | "global" | "eu" | "us" | "uk"`
- `timeoutMs?`

`handleLogin`
- `username` (required)
- `password` (required)
- `strategy?: "auto" | "generic" | "site"`
- `siteAdapter?`
- `requireFound?`
- `timeoutMs?`

`waitFor`
- `condition` (required; see kinds below)
- `timeoutMs?`

`snapshot`
- no extra fields

`setViewport`
- `width` (required)
- `height` (required)

`switchProfile`
- `profile` (required)
- `profilesRoot?`
- `url?`
- `waitUntil?: "load" | "domcontentloaded" | "networkidle"`
- `timeoutMs?`

`mock`
- `route.urlPattern` (required)
- optional route fields: `method`, `status`, `headers`, `contentType`, `body`, `json`

`checkpoint`
- `name` (required)
- `rootDir?`

### 5.4 `waitFor.condition` kinds

`timeout`
- `ms` (required)

`selector`
- `selector` (required)
- `state?: "attached" | "detached" | "visible" | "hidden"`

`network_idle`
- no extra fields

`network_response`
- optional predicates:
  - `urlContains?`
  - `urlMatches?`
  - `method?`
  - `status?`
  - `statusMin?`
  - `statusMax?`
  - `bodyIncludes?`
  - `bodyMatches?`
  - `ignoreCase?`
- validation rules:
  - at least one predicate is required
  - if both provided, `statusMin <= statusMax`

### 5.5 `assert.condition` kinds

`selector`
- `selector`
- `state?`
- `textContains?`

`selector_bbox_min`
- `selector`
- `minWidth`
- `minHeight`
- `requireCount?`

`selector_overlap_max`
- `selectorA`
- `selectorB`
- `maxOverlapRatio` (0..1)

`url_contains`
- `value`

`title_contains`
- `value`

`visual_baseline`
- `baselinePath`
- `maxMismatchRatio?`
- `threshold?`
- `diffPath?`

## 6) Loop Script Schema (Complete)

Loop script format:

```json
{
  "settings": { "deterministic": true },
  "setupActions": [{ "type": "navigate", "url": "http://127.0.0.1:4173/loop.html" }],
  "stepAction": { "type": "click", "target": { "kind": "css", "selector": "#next" } },
  "branches": [{ "label": "default", "next": "continue" }],
  "maxIterations": 10
}
```

Loop top-level fields:
- `settings?`
- `setupActions?`
- `stepAction` (required)
- `branches` (required, at least one)
- `maxIterations?`
- `continueOnStepError?`
- `captureObservationSnapshot?`

Branch fields:
- `label?`
- `match?: "all" | "any"`
- `when?` (predicate array)
- `actions?` (actions to run when branch matches)
- `next?: "continue" | "break"`

Predicate kinds:
- `snapshot`: compare `url|title|domHash|nodeCount|interactiveCount` with operator `contains|equals|not_equals|gt|gte|lt|lte`
- `assert`: reuse assert conditions (with optional `timeoutMs`)
- both predicate kinds support `negate?`

## 7) Determinism, Retries, and Long-Run Controls

Determinism:
- keep deterministic mode on unless investigating drift
- prefer semantic targets and explicit waits

Retries:
- configure `maxActionAttempts` and `retryBackoffMs`
- retries apply to retryable failures; fatal errors stop immediately
- evidence is captured per attempt in action result + trace/timeline metadata

Pause/Resume:
- `pause` action can block until Enter or timeout
- run-level control via `run-control` socket
- runtime overlay can pause/resume when enabled

Intervention journal retention:
- cap with `maxInterventionsRetained`
- choose trimming policy with `interventionRetentionMode` (`count|severity`)
- reserve source slots with `interventionSourceQuotas`

Checkpoint/Resume:
- add `checkpoint` actions in long scripts
- continue via `run --resume-from-checkpoint <name>`
- checkpoint resume is script-hash-safe

## 8) Diagnostics and Artifacts

Primary diagnostics:
- `timeline` and `timeline-html` for action-by-action analysis
- `replay` + `flake` for deterministic and stability validation
- `visual-diff` for screenshot regressions
- `selector-health` for target fragility hotspots
- `run-index` for machine-readable artifact linkage
- `bundle` for portable triage handoff
- `drift-monitor` for recurring cross-run failure signatures

Key output paths:
- `traces/`
- `reports/runtime-logs/`
- `reports/site-matrix-summary.json`
- `reports/drift-monitor/history.json`
- `reports/drift-monitor/aggregate.json`
- `reports/drift-monitor/recommendations.json`
- `reports/timeline-html/`
- `reports/visual-diff/`
- `reports/triage-bundles/`
- `.sazen/artifacts/`
- `.sazen/context/latest.json` and `.sazen/context/attachments.jsonl`
- `.sazen/context/context-index.json`
- `.sazen/sessions/`
- `.sazen/profiles/`

### 8.1 Critical: screenshot context is file-backed, not model-auto-ingested

When an action produces a screenshot, Sazen writes files (artifacts + context pointers), but an external agent runtime does **not** automatically receive image bytes in model context.

This applies across adapter surfaces (`adapter-stdio`, `adapter-opencode`, `adapter-claude`, `adapter-codex`) unless your host/runtime explicitly inlines image payloads.

Required operator behavior for image-aware decisions:
1. Run screenshot-producing action (`click`, `fill`, `snapshot`, etc.).
2. Read `.sazen/context/latest.json` to resolve `latestPath` / `sourcePath`.
3. Explicitly load the referenced image file into agent context.
4. Only then decide the next action.

Do not assume "screenshot taken" means "model already sees image." Treat screenshot ingestion as an explicit read step every cycle.

Minimal pattern:

```bash
# 1) run action(s) that produce screenshots
npm run dev -- run examples/sample-flow.json --trace traces/sample-trace.json

# 2) read latest context pointer
cat .sazen/context/latest.json

# 3) load latestPath/sourcePath image into your agent runtime before deciding next action
```

## 9) Adapter Protocols

### 9.1 Shared contract

All adapters share methods from `src/sdk-contract.ts`:
- `ping`
- `createSession`
- `closeSession`
- `performAction`
- `runActions`
- `pauseSession`
- `resumeSession`
- `getSessionState`
- `session.pause`
- `session.resume`
- `session.state`
- `snapshot`
- `describe`
- `saveTrace`
- `saveSession`
- `shutdown`

Compatibility field:
- `ping.sdkContractVersion`

Session identity fields in responses:
- `adapterSessionId`
- `runtimeSessionId`
- `runtimeTabId`

### 9.2 `adapter-stdio`

Transport:
- line-delimited JSON requests over stdin
- line-delimited JSON responses over stdout
- responses can be out of order; correlate by `id`

Example:

```json
{"id":1,"method":"ping"}
{"id":2,"method":"createSession","params":{"options":{"headed":false,"deterministic":true}}}
{"id":3,"method":"performAction","params":{"sessionId":"<id>","action":{"type":"navigate","url":"http://localhost:3000"}}}
{"id":4,"method":"closeSession","params":{"sessionId":"<id>"}}
```

### 9.3 `adapter-opencode`

OpenCode aliases map to base methods:
- `oc.ping -> ping`
- `oc.session.create -> createSession`
- `oc.session.close -> closeSession`
- `oc.session.action -> performAction`
- `oc.session.run -> runActions`
- `oc.session.pause -> pauseSession`
- `oc.session.resume -> resumeSession`
- `oc.session.state -> getSessionState`
- `oc.session.snapshot -> snapshot`
- `oc.session.describe -> describe`
- `oc.session.saveTrace -> saveTrace`
- `oc.session.saveSession -> saveSession`
- `oc.shutdown -> shutdown`

### 9.4 `adapter-claude`

Method aliases:
- `cc.*` method aliases map similarly to base methods

Slash command routes:
- `cc.command` (or `claude.command`) with `params.command` set to:
  - `/browser/ping`
  - `/browser/session/create`
  - `/browser/session/close`
  - `/browser/session/action`
  - `/browser/session/run`
  - `/browser/session/pause`
  - `/browser/session/resume`
  - `/browser/session/state`
  - `/browser/session/snapshot`
  - `/browser/session/describe`
  - `/browser/session/save-trace`
  - `/browser/session/save-session`
  - `/browser/shutdown`

Claude response envelope:
- `ok: boolean`
- `status: "ok" | "error"`
- `data?: unknown`
- `error?: { message: string }`
- `meta: { adapter, requestMethod, mappedMethod, sdkContractVersion }`

### 9.5 `adapter-codex` (HTTP)

Start service:

```bash
npm run dev -- adapter-codex -- --host 127.0.0.1 --port 4242
```

Endpoints:
- `GET /v1/health`
- `POST /v1/adapter`
- `POST /v1/session/create`
- `POST /v1/session/close`
- `POST /v1/session/pause`
- `POST /v1/session/resume`
- `POST /v1/session/state`
- `POST /v1/session/snapshot`
- `POST /v1/session/describe`
- `POST /v1/session/save-trace`
- `POST /v1/session/save-session`
- `POST /v1/action`
- `POST /v1/run`
- `POST /v1/replay`
- `POST /v1/timeline`

Codex response envelope:
- `ok: boolean`
- `status: "ok" | "error"`
- `data?: unknown`
- `error?: { message: string }`
- `meta: { endpoint, sdkContractVersion, timestamp }`

## 10) How to Explain Results to Humans

When reporting outcomes, always include:
- what you attempted (script/command and intent)
- whether run passed or failed
- where evidence is located (trace and reports paths)
- the failing step and reason (if failed)
- next practical actions (rerun mode, selector fix, retry/profile/checkpoint strategy)

Good summary shape:
1. Outcome (`passed` / `failed` / `flaky`) and run context
2. Key evidence (`trace`, timeline report, bundle, visual diff)
3. Root cause hypothesis (selector drift, timing, auth, network)
4. Exact follow-up commands humans can run

## 11) Required Validation Loop

For non-trivial changes:

```bash
npm run build
npm test
npm run smoke:sites -- --operation-timeout-ms 60000 --action-timeout-ms 30000 --stability-profile balanced
```

Also run at least one representative fixture script end-to-end and save a trace.

## 12) Completion Criteria

- command behavior validated by build/tests/smoke
- docs updated when behavior changes
- no missing artifact paths for debugging
- humans can reproduce and inspect outcomes from provided commands and files
