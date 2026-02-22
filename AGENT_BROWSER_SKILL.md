# Agent Browser Skill

Load this document as a reusable skill/context when an agent needs deterministic browser automation, replay, and triage in this repository.

## Purpose

Use `agent-browser` when you need:
- reproducible browser action execution
- structured DOM snapshots + diffs
- trace capture/replay/flake analysis
- action-level artifacts for debugging (screenshots, timeline, bundle)
- immediate screenshot handoff via `.agent-browser/context/latest.json`

## Fast Start

1. Build and test first:

```bash
npm run build
npm test
```

2. Run a script:

```bash
npm run dev -- run examples/sample-flow.json --trace traces/sample-trace.json --live-timeline

# interactive terminal timeline pane
npm run dev -- run examples/sample-flow.json --live-timeline --live-timeline-mode tui
```

Loop mode (action -> observe -> branch):

```bash
npm run dev -- loop examples/loop-flow.json --trace traces/loop-trace.json
```

Optional long-run control socket:

```bash
npm run dev -- run examples/sample-flow.json --control-socket reports/runtime-logs/run-control.sock
npm run dev -- run-control state --socket reports/runtime-logs/run-control.sock
npm run dev -- run-control pause --socket reports/runtime-logs/run-control.sock
npm run dev -- run-control resume --socket reports/runtime-logs/run-control.sock
```

3. Triage if needed:

```bash
npm run dev -- replay traces/sample-trace.json --mode relaxed
npm run dev -- timeline traces/sample-trace.json --artifacts --annotated-artifacts
npm run dev -- bundle traces/sample-trace.json --copy-artifacts
npm run dev -- timeline-html traces/sample-trace.json
npm run dev -- selector-health traces/sample-trace.json
npm run dev -- run-index traces/sample-trace.json
npm run dev -- drift-monitor
```

Use timeline HTML presets and diff-only focus mode for long traces when narrowing to high-signal rows.

## Agent Workflow

- Prefer `run` with JSON scripts over ad-hoc manual action chains.
- Use `loop` for bounded iterative workflows that need predicate-based branching.
- Keep deterministic mode enabled unless explicitly diagnosing runtime drift.
- Use semantic targets first (`roleName`, `stableRef`, `node`) and CSS only as fallback.
- Use `switchProfile` inside scripts when a single run needs role transitions (for example, user to admin).
- Use `assert` with `visual_baseline` when step-level screenshot gating is needed.
- Use `waitFor` with `condition.kind = network_response` when synchronizing on API responses (URL/method/status/body) instead of only DOM heuristics.
- Use bounded retries (`maxActionAttempts`, `retryBackoffMs`) for transient timeout/network flake; inspect `result.retry` attempt evidence before changing selectors.
- Use `checkpoint` actions on long scripts and recover with `run --resume-from-checkpoint <name>` when failures occur mid-flow.
- Use `handleLogin` when site plugin selectors are available (`siteAdapter`) before hand-authoring login fill/click chains.
- If strict replay mismatches on public/dynamic pages, retry with relaxed replay + selector invariants.
- For unstable traces, run `flake` before changing selectors.

## Browser Overlay Controls

- A runtime overlay is injected into pages by default (Pause/Resume).
- Overlay pause blocks subsequent automated actions until resumed.
- Overlay UI is excluded from snapshot modeling/diffs so hashes remain meaningful.

## Pause Provenance

- Run-level pause/resume events are recorded as timeline markers (`pause_start`, `pause_resume`).
- Saved traces include `interventions` journal entries with pre/post URL + DOM hash, storage deltas, and reconciliation hints.
- Use `maxInterventionsRetained` (or CLI `--max-interventions-retained`) when long sessions should cap retained intervention history.
- Use `interventionRetentionMode: "severity"` (or CLI `--intervention-retention-mode severity`) to preserve high-impact interventions when trimming.
- Use `interventionSourceQuotas` (or CLI `--intervention-source-quotas overlay=1,cli=1`) to reserve retention slots for key pause sources.

## Consent Strategy Hooks

- `handleConsent` supports `strategy` (`auto|cmp|generic`), `region` (`auto|global|eu|us|uk`), and optional `siteAdapter` host hint.
- Use `strategy: auto` for mixed CMP + site-specific matching; use `cmp` when debugging common CMP frameworks directly.
- Consent resolution is plugin-registry based (site adapter plugin, CMP plugin, generic plugin in deterministic priority order).

## Login Strategy Hooks

- `handleLogin` uses the same registry core with ordered site plugin + generic fallback resolution.
- Initial login plugin coverage includes GitHub-style selectors.

## Adapter Runtime (`adapter-stdio`)

Start server:

```bash
npm run dev -- adapter-stdio
npm run dev -- adapter-opencode
```

Send JSON lines:

```json
{"id":1,"method":"ping"}
{"id":2,"method":"createSession","params":{"options":{"headed":false,"deterministic":true}}}
{"id":3,"method":"performAction","params":{"sessionId":"<id>","action":{"type":"navigate","url":"http://localhost:3000"}}}
{"id":4,"method":"pauseSession","params":{"sessionId":"<id>"}}
{"id":5,"method":"resumeSession","params":{"sessionId":"<id>"}}
{"id":6,"method":"closeSession","params":{"sessionId":"<id>"}}
```

Notes:
- Responses can arrive out of order; correlate by `id`.
- Session operations are serialized per session for safety.
- MCP-parity aliases are available: `session.pause`, `session.resume`, `session.state`.
- Use `adapterSessionId` for adapter calls; `runtimeSessionId`/`runtimeTabId` identify the underlying browser runtime entities.
- Use `ping.sdkContractVersion` to verify compatibility with `src/sdk-contract.ts`.
- `adapter-opencode` supports `oc.*` method aliases mapped onto the unified SDK contract methods.

## Validation Loop (Required)

For non-trivial runtime changes:
- run unit/integration tests
- run at least one fixture script end-to-end
- run cross-site matrix with timeout guards

```bash
npm run smoke:sites -- --operation-timeout-ms 60000 --action-timeout-ms 30000 --stability-profile balanced
```

Smoke runs append drift-monitor outputs:
- `reports/drift-monitor/history.json`
- `reports/drift-monitor/aggregate.json`

## Done Criteria

- build + tests pass
- traces remain replayable for deterministic fixtures
- no new unresolved high-priority plan item for current feature slice
- changes documented in `README.md`, `.plan`, and `agents.md` when behavior/rules changed
