import type { Action, SavedTrace, SelectorHealthReport, SelectorHealthTopTarget, TraceRecord } from "./types.js";

export interface SelectorHealthRates {
  fallbackRate: number;
  ambiguityRate: number;
}

interface MutableTargetStats {
  total: number;
  failures: number;
  timeouts: number;
  fallbackDepthSum: number;
  fallbackDepthCount: number;
}

export function buildSelectorHealthReport(trace: SavedTrace, tracePath?: string): SelectorHealthReport {
  const totals = {
    selectorActions: 0,
    fallbackUsed: 0,
    ambiguous: 0,
    failures: 0,
    timeoutFailures: 0
  };

  const fallbackHistogram = new Map<number, number>();
  let fallbackDepthSum = 0;
  let fallbackDepthCount = 0;
  let fallbackDepthMax = 0;

  const targetStats = new Map<string, MutableTargetStats>();

  for (const record of trace.records) {
    const selectorAction = isSelectorAction(record.action);
    const target = resolveSelectorTarget(record);

    if (selectorAction) {
      totals.selectorActions += 1;
    }

    if (typeof record.result.selectorFallbackDepth === "number") {
      const depth = Math.max(0, Math.floor(record.result.selectorFallbackDepth));
      fallbackDepthSum += depth;
      fallbackDepthCount += 1;
      fallbackDepthMax = Math.max(fallbackDepthMax, depth);
      fallbackHistogram.set(depth, (fallbackHistogram.get(depth) ?? 0) + 1);
      if (depth > 0) {
        totals.fallbackUsed += 1;
      }
    }

    if ((record.result.selectorCandidateCount ?? 0) > 1) {
      totals.ambiguous += 1;
    }

    const failed = record.result.status !== "ok";
    if (failed) {
      totals.failures += 1;
    }

    const timeoutFailure = failed && isTimeoutMessage(record.result.errorMessage);
    if (timeoutFailure) {
      totals.timeoutFailures += 1;
    }

    if (!target) {
      continue;
    }

    const stats = targetStats.get(target) ?? {
      total: 0,
      failures: 0,
      timeouts: 0,
      fallbackDepthSum: 0,
      fallbackDepthCount: 0
    };

    if (selectorAction) {
      stats.total += 1;
    }

    if (failed) {
      stats.failures += 1;
    }

    if (timeoutFailure) {
      stats.timeouts += 1;
    }

    if (typeof record.result.selectorFallbackDepth === "number") {
      const depth = Math.max(0, Math.floor(record.result.selectorFallbackDepth));
      stats.fallbackDepthSum += depth;
      stats.fallbackDepthCount += 1;
    }

    targetStats.set(target, stats);
  }

  const topTargets: SelectorHealthTopTarget[] = [...targetStats.entries()]
    .map(([target, stats]) => ({
      target,
      total: stats.total,
      failures: stats.failures,
      timeouts: stats.timeouts,
      avgFallbackDepth:
        stats.fallbackDepthCount > 0 ? round(stats.fallbackDepthSum / stats.fallbackDepthCount, 3) : 0
    }))
    .sort((left, right) => {
      if (right.failures !== left.failures) {
        return right.failures - left.failures;
      }
      if (right.total !== left.total) {
        return right.total - left.total;
      }
      return left.target.localeCompare(right.target);
    })
    .slice(0, 8);

  return {
    createdAt: new Date().toISOString(),
    tracePath,
    totals,
    fallbackDepth: {
      average: fallbackDepthCount > 0 ? round(fallbackDepthSum / fallbackDepthCount, 3) : 0,
      max: fallbackDepthMax,
      histogram: Object.fromEntries(
        [...fallbackHistogram.entries()].sort((left, right) => left[0] - right[0]).map(([depth, count]) => [
          String(depth),
          count
        ])
      )
    },
    topTargets
  };
}

export function formatSelectorHealthSummary(report: SelectorHealthReport): string[] {
  const lines = [
    `selector actions=${report.totals.selectorActions} failures=${report.totals.failures} timeoutFailures=${report.totals.timeoutFailures}`,
    `fallback used=${report.totals.fallbackUsed} ambiguous=${report.totals.ambiguous} avgDepth=${report.fallbackDepth.average} maxDepth=${report.fallbackDepth.max}`
  ];

  if (report.topTargets.length > 0) {
    lines.push("top targets:");
    for (const target of report.topTargets.slice(0, 3)) {
      lines.push(
        `- ${target.target} total=${target.total} failures=${target.failures} timeouts=${target.timeouts} avgDepth=${target.avgFallbackDepth}`
      );
    }
  }

  return lines;
}

export function computeSelectorHealthRates(report: SelectorHealthReport): SelectorHealthRates {
  const total = Math.max(0, report.totals.selectorActions);
  if (total === 0) {
    return {
      fallbackRate: 0,
      ambiguityRate: 0
    };
  }

  return {
    fallbackRate: round(report.totals.fallbackUsed / total, 4),
    ambiguityRate: round(report.totals.ambiguous / total, 4)
  };
}

function isSelectorAction(action: Action): boolean {
  if (action.type === "click" || action.type === "fill" || action.type === "select") {
    return true;
  }

  if (action.type === "waitFor" && action.condition.kind === "selector") {
    return true;
  }

  if (action.type === "assert") {
    return (
      action.condition.kind === "selector" ||
      action.condition.kind === "selector_bbox_min" ||
      action.condition.kind === "selector_overlap_max"
    );
  }

  return false;
}

function resolveSelectorTarget(record: TraceRecord): string | undefined {
  if (record.result.selectorTarget && record.result.selectorTarget.length > 0) {
    return record.result.selectorTarget;
  }

  const action = record.action;
  if (action.type === "click" || action.type === "fill" || action.type === "select") {
    if (action.target?.kind === "css") {
      return `css:${action.target.selector}`;
    }
    if (action.target?.kind === "stableRef") {
      return `stableRef:${action.target.value}`;
    }
    if (action.target?.kind === "roleName") {
      return `roleName:${action.target.role}:${action.target.name}`;
    }
    if (action.target?.kind === "node") {
      return `node:${action.target.nodeId}`;
    }
    if (action.nodeId) {
      return `node:${action.nodeId}`;
    }
  }

  if (action.type === "waitFor" && action.condition.kind === "selector") {
    return `waitFor:${action.condition.selector}`;
  }

  if (action.type === "assert") {
    if (action.condition.kind === "selector") {
      return `assert:${action.condition.selector}`;
    }
    if (action.condition.kind === "selector_bbox_min") {
      return `assert_bbox:${action.condition.selector}`;
    }
    if (action.condition.kind === "selector_overlap_max") {
      return `assert_overlap:${action.condition.selectorA}|${action.condition.selectorB}`;
    }
  }

  return undefined;
}

function isTimeoutMessage(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  return message.toLowerCase().includes("timeout");
}

function round(value: number, precision: number): number {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}
