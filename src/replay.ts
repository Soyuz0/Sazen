import { resolve } from "node:path";
import { AgentSession } from "./session.js";
import { loadSavedTrace } from "./trace.js";
import type {
  Action,
  AgentNode,
  AgentSessionOptions,
  FlakeReport,
  ReplayMode,
  ReplayOptions,
  ReplayReport,
  SavedTrace,
  TraceRecord
} from "./types.js";

const DEFAULT_REPLAY_OPTIONS: Required<ReplayOptions> = {
  mode: "strict",
  preflight: true,
  preflightTimeoutMs: 4_000,
  selectorInvariants: true
};

export async function replayTrace(
  tracePath: string,
  options: AgentSessionOptions = {},
  replayOptions: ReplayOptions = {}
): Promise<ReplayReport> {
  const effectiveReplayOptions = { ...DEFAULT_REPLAY_OPTIONS, ...replayOptions };
  const { absolutePath, trace } = await loadSavedTrace(tracePath);
  const requiredOrigins = collectRequiredOrigins(trace);

  if (effectiveReplayOptions.preflight) {
    await runPreflightChecks(requiredOrigins, effectiveReplayOptions.preflightTimeoutMs);
  }

  const session = new AgentSession(options);
  await session.start();

  let matched = 0;
  let mismatched = 0;
  let selectorChecks = 0;
  let selectorMismatches = 0;
  const mismatches: ReplayReport["mismatches"] = [];

  try {
    for (const [index, record] of trace.records.entries()) {
      const result = await session.perform(record.action);
      const comparison = compareReplayRecord(
        record,
        result,
        effectiveReplayOptions.mode,
        effectiveReplayOptions.selectorInvariants
      );

      if (comparison.selectorCheckPerformed) {
        selectorChecks += 1;
      }
      if (comparison.selectorMismatch) {
        selectorMismatches += 1;
      }

      if (!comparison.mismatch) {
        matched += 1;
      } else {
        mismatched += 1;
        mismatches.push({
          index,
          reason: comparison.mismatch.reason,
          expected: comparison.mismatch.expected,
          actual: comparison.mismatch.actual,
          actionType: record.action.type
        });
      }
    }
  } finally {
    await session.close();
  }

  return {
    tracePath: absolutePath,
    mode: effectiveReplayOptions.mode,
    totalActions: trace.records.length,
    matched,
    mismatched,
    preflight: {
      checkedOrigins: requiredOrigins,
      skipped: !effectiveReplayOptions.preflight
    },
    invariants: {
      selectorEnabled: effectiveReplayOptions.selectorInvariants && effectiveReplayOptions.mode === "relaxed",
      selectorChecks,
      selectorMismatches
    },
    mismatches
  };
}

export async function detectFlakes(
  tracePath: string,
  runs: number,
  options: AgentSessionOptions = {},
  replayOptions: ReplayOptions = {}
): Promise<FlakeReport> {
  if (!Number.isInteger(runs) || runs < 2) {
    throw new Error("Flake detection requires at least 2 runs");
  }

  const mismatchCounts = new Map<number, { actionType: Action["type"]; mismatchRuns: number }>();

  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    const report = await replayTrace(tracePath, options, {
      ...replayOptions,
      preflight: runIndex === 0 ? replayOptions.preflight : false
    });

    for (const mismatch of report.mismatches) {
      const existing = mismatchCounts.get(mismatch.index);
      if (existing) {
        existing.mismatchRuns += 1;
      } else {
        mismatchCounts.set(mismatch.index, {
          actionType: mismatch.actionType,
          mismatchRuns: 1
        });
      }
    }
  }

  const unstableActions = [...mismatchCounts.entries()]
    .map(([index, summary]) => ({
      index,
      actionType: summary.actionType,
      mismatchRuns: summary.mismatchRuns
    }))
    .sort((left, right) => right.mismatchRuns - left.mismatchRuns || left.index - right.index);

  return {
    tracePath: resolve(tracePath),
    runs,
    mode: replayOptions.mode ?? DEFAULT_REPLAY_OPTIONS.mode,
    unstableActions
  };
}

interface ReplayMismatch {
  reason: "dom_hash" | "status" | "url" | "selector_invariant";
  expected: string;
  actual: string;
}

interface ReplayComparison {
  mismatch: ReplayMismatch | null;
  selectorCheckPerformed: boolean;
  selectorMismatch: boolean;
}

function compareReplayRecord(
  record: TraceRecord,
  result: {
    status: TraceRecord["result"]["status"];
    postSnapshot: { domHash: string; url: string; nodes: AgentNode[] };
  },
  mode: ReplayMode,
  selectorInvariants: boolean
): ReplayComparison {
  if (mode === "strict") {
    if (result.postSnapshot.domHash !== record.result.postDomHash) {
      return {
        mismatch: {
          reason: "dom_hash",
          expected: record.result.postDomHash,
          actual: result.postSnapshot.domHash
        },
        selectorCheckPerformed: false,
        selectorMismatch: false
      };
    }
    return {
      mismatch: null,
      selectorCheckPerformed: false,
      selectorMismatch: false
    };
  }

  if (result.status !== record.result.status) {
    return {
      mismatch: {
        reason: "status",
        expected: record.result.status,
        actual: result.status
      },
      selectorCheckPerformed: false,
      selectorMismatch: false
    };
  }

  if (record.result.postUrl && !isComparableUrl(record.result.postUrl, result.postSnapshot.url)) {
    return {
      mismatch: {
        reason: "url",
        expected: normalizeComparableUrl(record.result.postUrl),
        actual: normalizeComparableUrl(result.postSnapshot.url)
      },
      selectorCheckPerformed: false,
      selectorMismatch: false
    };
  }

  if (selectorInvariants && record.result.waitForSelector) {
    const selectorResult = evaluateSelectorInvariant(record.result.waitForSelector, result.postSnapshot.nodes);
    if (selectorResult.supported) {
      if (selectorResult.matchCount === 0) {
        return {
          mismatch: {
            reason: "selector_invariant",
            expected: `selector '${record.result.waitForSelector}' to match >= 1 node`,
            actual: "0 matches"
          },
          selectorCheckPerformed: true,
          selectorMismatch: true
        };
      }

      return {
        mismatch: null,
        selectorCheckPerformed: true,
        selectorMismatch: false
      };
    }
  }

  return {
    mismatch: null,
    selectorCheckPerformed: false,
    selectorMismatch: false
  };
}

function collectRequiredOrigins(trace: SavedTrace): string[] {
  if (trace.environment?.requiredOrigins && trace.environment.requiredOrigins.length > 0) {
    return [...new Set(trace.environment.requiredOrigins)].sort((left, right) => left.localeCompare(right));
  }

  const origins = new Set<string>();

  for (const record of trace.records) {
    if (record.action.type === "navigate") {
      addOrigin(origins, record.action.url);
    }
    if (record.result.postUrl) {
      addOrigin(origins, record.result.postUrl);
    }
  }

  return [...origins].sort((left, right) => left.localeCompare(right));
}

async function runPreflightChecks(origins: string[], timeoutMs: number): Promise<void> {
  if (origins.length === 0) {
    return;
  }

  const failures: string[] = [];
  for (const origin of origins) {
    const ok = await probeOrigin(origin, timeoutMs);
    if (!ok) {
      failures.push(origin);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        "Replay preflight failed. Required origins are unreachable:",
        ...failures.map((origin) => `- ${origin}`),
        "Start the missing services or run replay with --no-preflight."
      ].join("\n")
    );
  }
}

async function probeOrigin(origin: string, timeoutMs: number): Promise<boolean> {
  const methods: Array<"HEAD" | "GET"> = ["HEAD", "GET"];

  for (const method of methods) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(origin, {
        method,
        redirect: "follow",
        signal: controller.signal
      });

      if (response.status < 500) {
        return true;
      }
    } catch {
      // Try next method.
    } finally {
      clearTimeout(timer);
    }
  }

  return false;
}

function addOrigin(origins: Set<string>, input: string): void {
  try {
    const parsed = new URL(input);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      origins.add(parsed.origin);
    }
  } catch {
    // Ignore malformed urls.
  }
}

function isComparableUrl(expected: string, actual: string): boolean {
  return normalizeComparableUrl(expected) === normalizeComparableUrl(actual);
}

function normalizeComparableUrl(input: string): string {
  try {
    const parsed = new URL(input);
    const path = parsed.pathname.replace(/\/$/, "") || "/";
    return `${parsed.origin}${path}`;
  } catch {
    return input;
  }
}

interface SelectorInvariantResult {
  supported: boolean;
  matchCount: number;
}

function evaluateSelectorInvariant(selector: string, nodes: AgentNode[]): SelectorInvariantResult {
  const parsed = parseSimpleSelector(selector);
  if (!parsed) {
    return {
      supported: false,
      matchCount: 0
    };
  }

  let matchCount = 0;
  for (const node of nodes) {
    if (matchesSimpleSelector(node, parsed)) {
      matchCount += 1;
    }
  }

  return {
    supported: true,
    matchCount
  };
}

interface ParsedSimpleSelector {
  tag?: string;
  id?: string;
  attribute?: {
    name: string;
    operator: "=" | "*=";
    value: string;
  };
}

function parseSimpleSelector(selector: string): ParsedSimpleSelector | null {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (/[\s>+~:]/.test(trimmed)) {
    return null;
  }

  const pattern =
    /^(?<tag>[a-z][a-z0-9_-]*)?(?:#(?<id>[a-zA-Z0-9_-]+))?(?:\[(?<attr>[a-zA-Z0-9_-]+)(?<op>\*=|=)['"]?(?<value>[^'"\]]+)['"]?\])?$/;
  const match = trimmed.match(pattern);
  if (!match || !match.groups) {
    return null;
  }

  const parsed: ParsedSimpleSelector = {};
  if (match.groups.tag) {
    parsed.tag = match.groups.tag.toLowerCase();
  }
  if (match.groups.id) {
    parsed.id = match.groups.id;
  }
  if (match.groups.attr && match.groups.op && match.groups.value) {
    const operator = match.groups.op === "*=" ? "*=" : "=";
    parsed.attribute = {
      name: match.groups.attr,
      operator,
      value: match.groups.value
    };
  }

  return parsed;
}

function matchesSimpleSelector(node: AgentNode, selector: ParsedSimpleSelector): boolean {
  if (selector.tag && node.tag !== selector.tag) {
    return false;
  }

  if (selector.id) {
    if ((node.attributes.id ?? "") !== selector.id) {
      return false;
    }
  }

  if (selector.attribute) {
    const actual = node.attributes[selector.attribute.name] ?? "";
    if (selector.attribute.operator === "=") {
      if (actual !== selector.attribute.value) {
        return false;
      }
    } else if (!actual.includes(selector.attribute.value)) {
      return false;
    }
  }

  return true;
}
