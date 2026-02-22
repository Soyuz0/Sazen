# Agent Runtime Rules

These rules define how autonomous agents should operate when using this browser runtime.

## 1) Safety and Scope
- Only act on allowlisted domains or explicit user-provided URLs.
- Never submit destructive actions (delete, purchase, transfer) unless explicitly instructed.
- Redact likely secrets from logs and traces (tokens, passwords, cookies, auth headers).
- Keep a complete audit trail of all actions.

## 2) Deterministic-by-Default
- Run with deterministic mode enabled unless a task opts out.
- Disable animations/transitions and prefer reduced motion.
- Use stable waits (network idle + DOM quiet window), not arbitrary long sleeps.
- Record enough state to replay every action.

## 3) Atomic Action Discipline
- Execute one atomic action at a time.
- Each action must include pre/post snapshots and a DOM diff.
- Verify action effects before moving to the next step.
- Retry only retryable failures with bounded attempts.

## 4) Element Targeting
- Prefer semantic targeting (role/name, stableRef, test id).
- Use raw CSS selectors only as fallback.
- Avoid brittle nth-child selectors when possible.
- Surface candidate targets when ambiguity is detected.

## 5) Observability Requirements
- Capture console, network, page errors, and request failures.
- Stream logs in real time for human visibility.
- Attach screenshot artifacts to action results when enabled.
- Use viewport screenshot mode for routine runs; only use fullpage screenshots when needed for deep visual audits.
- Keep event ordering stable with timestamps.
- Provide agent-first page descriptions (what is present, where it is, and how to interact).
- Include positional/visual issue hints (offscreen targets, tiny hit areas, overlaps, disabled controls).
- Persist runtime logs under repo-managed paths (`reports/`), not temporary OS directories.

## 6) Multi-Agent Isolation
- Keep each run in its own browser context/session namespace.
- Do not share storage/cookies across agents unless explicitly linked.
- Track action ownership by session and tab IDs.

## 7) Persistence and Replay
- Support session save/load (URL + storage state).
- Save trace as append-only action history.
- Replay should validate expected hashes and flag mismatches.
- Run replay preflight checks by default; only skip with explicit reason.
- Use strict replay for deterministic fixtures and relaxed replay for dynamic public sites.
- In relaxed mode, keep selector-level invariants enabled unless intentionally diagnosing noise.
- Use flake detection (`flake`) when strict replay mismatches appear intermittent.
- Use `timeline` outputs to review action-by-action behavior before declaring a run healthy.

## 8) Failure Handling
- Classify failures as retryable vs fatal.
- On failure, capture final snapshot + logs + screenshot.
- Return actionable diagnostics (which target failed, why, what changed).

## 9) Human-Visible Mode
- Default to headed Chromium for local project testing.
- Make current action and recent events visible in CLI output.
- Keep browser open in `open` mode until explicit interrupt.

## 10) Git Hygiene
- Keep changes scoped and auditable.
- Avoid unrelated edits.
- Do not rewrite history unless explicitly requested.
- After a successful testing run, commit all intended changes so the validated state is preserved.

## 11) Mandatory Testing
- Every implementation change must ship with automated tests where practical (unit, integration, or both).
- Run the test suite before declaring work complete.
- If a test cannot be added, document why and provide a concrete follow-up test task.
- Run long tests/smoke suites with explicit timeout guards to avoid stuck sessions.
- Prefer per-action/per-site timeouts in matrix runners, not only global command timeouts.

## 12) Dogfooding Requirement
- While building features, run the runtime against a real app flow (local fixture or target project).
- Use the agent browser itself to execute and validate actions, not only isolated unit checks.
- Confirm real-time logs/action output and action-result envelopes during these runs.
- Validate viewport-dependent behavior by testing multiple resolutions.
- For unattended/long automation runs, prefer headless mode unless visual validation is the goal.

## 13) Continuous Feature Planning
- During implementation, continuously identify high-value browser features and append them to `.plan`.
- Keep plan updates prioritized (near-term, mid-term, long-term differentiators).
- Record rationale so roadmap decisions remain traceable.
- After each real app dogfooding run, note at least one feature gap discovered and log it in `.plan`.
- Maintain a dedicated "Feature Gaps Found During Dogfooding" section in `.plan`.

## 14) Cross-Site Validation Loop
- Test batches of real websites in a row, not only local fixtures.
- Include variety: static pages, docs, news/media, app-like search/navigation, and JS-heavy SPAs.
- In each site flow, perform actual navigation steps (not just landing page loads).
- Continue iteration until consecutive multi-site runs reveal no new bugs.
- For long smoke runs, set explicit timeout flags and persist run logs to `reports/runtime-logs/`.
- When comparing behavior changes, run `visual-diff` between baseline/candidate traces to catch visual regressions.

## 15) Execute Findings, Not Just Record Them
- Every meaningful bug discovered during site runs should be triaged and implemented when feasible.
- After each fix, re-run affected sites and then the full multi-site matrix.
- Add both implemented fixes and deferred items to `.plan`.
- Keep a final consecutive passing run across the full site matrix before closing work.

## 16) Completion Discipline
- Continue implementing planned scope iteratively without stopping at intermediate milestones.
- Only pause for completion reporting after tests pass and no high-priority plan items remain for the current phase.
- If the user explicitly says "don't stop until done", keep executing plan items and validations until a full pass is achieved.
