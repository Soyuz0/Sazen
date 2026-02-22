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

## Resolution / viewport
- Set viewport for any CLI run with `--viewport WIDTHxHEIGHT` (example: `--viewport 1920x1080`).
- You can also set viewport inside action scripts via:

```json
{ "type": "setViewport", "width": 1366, "height": 768 }
```

## Log noise filtering
- Noise filtering is enabled by default (suppresses common low-signal noise like favicon 404s).
- Use `--raw-logs` on commands to see the full unfiltered event stream.

## Script format
See `examples/sample-flow.json`.
