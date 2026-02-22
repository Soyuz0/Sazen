import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface MatrixSiteSummary {
  site: string;
  status: "ok" | "failed";
  failedActions: number;
  timedOut: boolean;
  durationMs: number;
  tracePath: string;
  selectorHealthPath?: string;
}

interface MatrixSummary {
  createdAt: string;
  totalSites: number;
  failedSites: number;
  sites: MatrixSiteSummary[];
}

interface SelectorHealthSnapshot {
  totals?: {
    failures?: number;
    timeoutFailures?: number;
  };
  topTargets?: Array<{
    target: string;
    failures: number;
    timeouts: number;
  }>;
}

export interface DriftFailureSignature {
  signature: string;
  site: string;
  tracePath: string;
  failedActions: number;
  timedOut: boolean;
  selectorTopTarget?: string;
  selectorFailures?: number;
  selectorTimeouts?: number;
}

export interface DriftRunRecord {
  runId: string;
  createdAt: string;
  sourceSummaryPath: string;
  totalSites: number;
  failedSites: number;
  sites: Array<{
    site: string;
    status: "ok" | "failed";
    failedActions: number;
    timedOut: boolean;
    durationMs: number;
  }>;
  failures: DriftFailureSignature[];
}

export interface DriftHistory {
  version: 1;
  createdAt: string;
  updatedAt: string;
  runs: DriftRunRecord[];
}

export interface DriftAggregateReport {
  createdAt: string;
  totalRuns: number;
  runsWithFailures: number;
  recurringFailures: Array<{
    signature: string;
    occurrences: number;
    sites: string[];
    latestSeenAt: string;
  }>;
  siteFailureRates: Array<{
    site: string;
    failedRuns: number;
    observedRuns: number;
    failureRate: number;
  }>;
}

export async function appendMatrixSummaryToDriftHistory(input: {
  matrixSummaryPath: string;
  historyPath?: string;
  aggregatePath?: string;
  maxRuns?: number;
}): Promise<{
  historyPath: string;
  aggregatePath: string;
  history: DriftHistory;
  aggregate: DriftAggregateReport;
}> {
  const matrixSummaryPath = resolve(input.matrixSummaryPath);
  const historyPath = resolve(input.historyPath ?? "reports/drift-monitor/history.json");
  const aggregatePath = resolve(input.aggregatePath ?? "reports/drift-monitor/aggregate.json");
  const maxRuns = Math.max(1, Math.floor(input.maxRuns ?? 120));

  const matrixRaw = await readFile(matrixSummaryPath, "utf8");
  const matrix = JSON.parse(matrixRaw) as MatrixSummary;

  const run = await toDriftRunRecord(matrix, matrixSummaryPath);
  const history = await readDriftHistory(historyPath);
  history.runs.push(run);
  if (history.runs.length > maxRuns) {
    history.runs.splice(0, history.runs.length - maxRuns);
  }
  history.updatedAt = new Date().toISOString();

  const aggregate = buildDriftAggregate(history);

  await mkdir(dirname(historyPath), { recursive: true });
  await writeFile(historyPath, JSON.stringify(history, null, 2), "utf8");

  await mkdir(dirname(aggregatePath), { recursive: true });
  await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2), "utf8");

  return {
    historyPath,
    aggregatePath,
    history,
    aggregate
  };
}

export function buildDriftAggregate(history: DriftHistory): DriftAggregateReport {
  const signatureStats = new Map<string, { count: number; sites: Set<string>; latestSeenAt: string }>();
  const siteStats = new Map<string, { observedRuns: number; failedRuns: number }>();

  for (const run of history.runs) {
    for (const site of run.sites) {
      const stats = siteStats.get(site.site) ?? { observedRuns: 0, failedRuns: 0 };
      stats.observedRuns += 1;
      if (site.status === "failed") {
        stats.failedRuns += 1;
      }
      siteStats.set(site.site, stats);
    }

    for (const failure of run.failures) {
      const stats =
        signatureStats.get(failure.signature) ??
        ({ count: 0, sites: new Set<string>(), latestSeenAt: run.createdAt } as {
          count: number;
          sites: Set<string>;
          latestSeenAt: string;
        });
      stats.count += 1;
      stats.sites.add(failure.site);
      if (run.createdAt > stats.latestSeenAt) {
        stats.latestSeenAt = run.createdAt;
      }
      signatureStats.set(failure.signature, stats);
    }
  }

  const recurringFailures = [...signatureStats.entries()]
    .map(([signature, stats]) => ({
      signature,
      occurrences: stats.count,
      sites: [...stats.sites].sort((left, right) => left.localeCompare(right)),
      latestSeenAt: stats.latestSeenAt
    }))
    .sort(
      (left, right) => right.occurrences - left.occurrences || left.signature.localeCompare(right.signature)
    );

  const siteFailureRates = [...siteStats.entries()]
    .map(([site, stats]) => ({
      site,
      failedRuns: stats.failedRuns,
      observedRuns: stats.observedRuns,
      failureRate: stats.observedRuns > 0 ? stats.failedRuns / stats.observedRuns : 0
    }))
    .sort((left, right) => right.failureRate - left.failureRate || left.site.localeCompare(right.site));

  return {
    createdAt: new Date().toISOString(),
    totalRuns: history.runs.length,
    runsWithFailures: history.runs.filter((run) => run.failedSites > 0).length,
    recurringFailures,
    siteFailureRates
  };
}

async function toDriftRunRecord(matrix: MatrixSummary, sourceSummaryPath: string): Promise<DriftRunRecord> {
  const failures: DriftFailureSignature[] = [];

  for (const site of matrix.sites) {
    if (site.status !== "failed") {
      continue;
    }

    const selector = await loadSelectorSignal(site.selectorHealthPath);
    failures.push({
      signature: buildFailureSignature(site, selector),
      site: site.site,
      tracePath: site.tracePath,
      failedActions: site.failedActions,
      timedOut: site.timedOut,
      selectorTopTarget: selector.topTarget,
      selectorFailures: selector.failures,
      selectorTimeouts: selector.timeoutFailures
    });
  }

  return {
    runId: `${matrix.createdAt}-${matrix.totalSites}-${matrix.failedSites}`,
    createdAt: matrix.createdAt,
    sourceSummaryPath,
    totalSites: matrix.totalSites,
    failedSites: matrix.failedSites,
    sites: matrix.sites.map((site) => ({
      site: site.site,
      status: site.status,
      failedActions: site.failedActions,
      timedOut: site.timedOut,
      durationMs: site.durationMs
    })),
    failures
  };
}

async function loadSelectorSignal(
  selectorHealthPath: string | undefined
): Promise<{ topTarget?: string; failures?: number; timeoutFailures?: number }> {
  if (!selectorHealthPath) {
    return {};
  }

  try {
    const raw = await readFile(resolve(selectorHealthPath), "utf8");
    const parsed = JSON.parse(raw) as SelectorHealthSnapshot;
    return {
      topTarget: parsed.topTargets?.[0]?.target,
      failures: parsed.totals?.failures,
      timeoutFailures: parsed.totals?.timeoutFailures
    };
  } catch {
    return {};
  }
}

function buildFailureSignature(
  site: MatrixSiteSummary,
  selector: { topTarget?: string; failures?: number; timeoutFailures?: number }
): string {
  const parts = [
    `site:${site.site}`,
    `timeout:${site.timedOut ? "yes" : "no"}`,
    `failedActions:${site.failedActions}`,
    `selectorTarget:${selector.topTarget ?? "none"}`,
    `selectorFailures:${selector.failures ?? 0}`,
    `selectorTimeouts:${selector.timeoutFailures ?? 0}`
  ];

  return parts.join("|");
}

async function readDriftHistory(historyPath: string): Promise<DriftHistory> {
  const raw = await readFile(historyPath, "utf8").catch((error) => {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes("enoent") || message.includes("no such file")) {
      return undefined;
    }
    throw error;
  });

  if (!raw) {
    const now = new Date().toISOString();
    return {
      version: 1,
      createdAt: now,
      updatedAt: now,
      runs: []
    };
  }

  const parsed = JSON.parse(raw) as DriftHistory;
  if (parsed.version !== 1 || !Array.isArray(parsed.runs)) {
    const now = new Date().toISOString();
    return {
      version: 1,
      createdAt: now,
      updatedAt: now,
      runs: []
    };
  }

  return parsed;
}
