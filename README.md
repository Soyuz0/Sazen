# Agent Browser (v0)

Agent-first browser runtime built on Playwright Chromium, optimized for deterministic testing and real-time observability.

## What exists now
- Headed Chromium runtime (visible by default).
- Atomic action API with structured result envelopes.
- DOM snapshots with stable node IDs and semantic metadata.
- Per-action DOM diffs.
- Console/network/error capture.
- Real-time log streaming in CLI.
- Session save/load and trace replay.

## Install
```bash
npm install
npm run install:browser
```

## Quick start
```bash
# open browser and keep it visible
npm run dev -- open https://example.com

# inspect interactive DOM nodes
npm run dev -- inspect https://example.com

# generate agent-oriented page description + issue hints
npm run dev -- describe https://example.com --viewport 1280x720

# run scripted actions
npm run dev -- run examples/sample-flow.json --trace traces/sample-trace.json

# run scripted actions headless (recommended for long test loops)
npm run dev -- run examples/sample-flow.json --headless

# load a previously saved session
npm run dev -- load my-session

# replay a trace
npm run dev -- replay traces/sample-trace.json

# replay with relaxed invariants + preflight
npm run dev -- replay traces/sample-trace.json --mode relaxed

# detect flaky actions across repeated replays
npm run dev -- flake traces/sample-trace.json --runs 5 --mode strict

# inspect stored trace timeline
npm run dev -- timeline traces/sample-trace.json --limit 20

# create a triage bundle for sharing/debugging
npm run dev -- bundle traces/sample-trace.json

# save/load named auth profile (manual login flow)
npm run dev -- profile-save my-admin http://localhost:3000/login
npm run dev -- profile-load my-admin

# non-interactive profile save/load for CI smoke checks
npm run dev -- profile-save ci-profile http://localhost:4173 --headless --auto-save-ms 2000
npm run dev -- profile-load ci-profile --headless --close-after-ms 2000

# run cross-site smoke matrix
npm run smoke:sites
```

## Fixture app for local testing
```bash
npm run fixture
```
Then open `http://localhost:4173`.

## Tests
```bash
npm test
```

## Site matrix smoke runs
- Flow files live in `examples/site-flows`.
- `npm run smoke:sites` runs all site flows and writes `reports/site-matrix-summary.json`.
- Runtime logs/artifacts can be kept in `reports/` and `.agent-browser/` (no `/tmp` requirement).
- Optional timeout guards: `npm run smoke:sites -- --operation-timeout-ms 60000 --action-timeout-ms 30000`.

## Replay modes
- `strict`: action post-state DOM hash must match trace exactly.
- `relaxed`: compares action status and normalized post-action URL (useful for dynamic pages).
- In relaxed mode, selector invariants from `waitFor(selector)` actions are checked by default.
- Disable selector checks with `--no-selector-invariants`.
- Replay runs preflight URL reachability checks by default; disable with `--no-preflight`.

## Assertions and consent helpers
- Action scripts can include assertion steps:

```json
{ "type": "assert", "condition": { "kind": "selector", "selector": "#status", "textContains": "ready" } }
```

- Visual/positional assertions are supported too:

```json
{ "type": "assert", "condition": { "kind": "selector_bbox_min", "selector": "button", "minWidth": 44, "minHeight": 24 } }
```

```json
{ "type": "assert", "condition": { "kind": "selector_overlap_max", "selectorA": "#cta", "selectorB": "#modal", "maxOverlapRatio": 0.0 } }
```

- Built-in consent helper for cookie walls:

```json
{ "type": "handleConsent", "mode": "accept", "requireFound": true }
```

## Stability profiles
- `--stability-profile fast|balanced|chatty` tunes quiet-window and network-idle budgets.
- Use `chatty` for heavily streaming pages; use `fast` for speed-focused deterministic checks.

## Timeline and bundles
- `timeline` supports `--status`, `--action`, `--artifacts`, and `--json` output modes.
- `bundle` creates a triage package in `reports/triage-bundles/` with trace + timeline manifest + screenshot references.
- Add `--copy-artifacts` to copy screenshot files into the bundle directory.

## Resolution / viewport
- Set viewport for any CLI run with `--viewport WIDTHxHEIGHT` (example: `--viewport 1920x1080`).
- You can also set viewport inside action scripts via:

```json
{ "type": "setViewport", "width": 1366, "height": 768 }
```

## Screenshot capture mode
- `--screenshot-mode viewport` (default): captures only visible viewport, reduces visual flashing.
- `--screenshot-mode fullpage`: captures full page (can trigger additional rendering/scroll work).

## Log noise filtering
- Noise filtering is enabled by default (suppresses common low-signal noise like favicon 404s).
- Use `--raw-logs` on commands to see the full unfiltered event stream.

## Redaction packs
- `--redaction-pack default`: baseline secret masking (tokens/passwords/auth headers).
- `--redaction-pack strict`: stronger masking (adds cookies/API keys/emails).
- `--redaction-pack off`: disable built-in masking (use carefully).

## Script format
See `examples/sample-flow.json`.
