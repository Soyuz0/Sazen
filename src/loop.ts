import { AgentSession } from "./session.js";
import type {
  Action,
  DomSnapshot,
  LoopBranch,
  LoopBranchResult,
  LoopIterationResult,
  LoopPredicate,
  LoopPredicateResult,
  LoopRunReport,
  LoopScript
} from "./types.js";

const DEFAULT_MAX_ITERATIONS = 5;

export async function runLoop(session: AgentSession, script: LoopScript): Promise<LoopRunReport> {
  const maxIterations = Math.max(1, script.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const continueOnStepError = script.continueOnStepError ?? false;
  const captureObservationSnapshot = script.captureObservationSnapshot ?? true;

  if (script.setupActions && script.setupActions.length > 0) {
    for (const action of script.setupActions) {
      const result = await session.perform(action);
      if (result.status !== "ok") {
        throw new Error(
          `Loop setup action '${action.type}' failed with status '${result.status}': ${result.error?.message ?? "unknown error"}`
        );
      }
    }
  }

  const iterations: LoopIterationResult[] = [];

  for (let index = 0; index < maxIterations; index += 1) {
    const iterationNumber = index + 1;
    const stepResult = await session.perform(script.stepAction);
    const iteration: LoopIterationResult = {
      iteration: iterationNumber,
      stepResult,
      branchResults: [],
      selectedBranchActionResults: []
    };

    if (stepResult.status !== "ok" && !continueOnStepError) {
      iterations.push(iteration);
      return {
        maxIterations,
        iterations,
        stopReason: "step_error"
      };
    }

    let observationSnapshot: DomSnapshot | undefined;
    const getObservationSnapshot = async (): Promise<DomSnapshot> => {
      if (!observationSnapshot) {
        observationSnapshot = await session.snapshot();
      }
      return observationSnapshot;
    };

    const branchResolution = await resolveBranches(
      session,
      script.branches,
      getObservationSnapshot,
      captureObservationSnapshot
    );

    iteration.branchResults = branchResolution.branchResults;
    iteration.selectedBranchLabel = branchResolution.selected?.label;
    iteration.selectedBranchNext = branchResolution.selected?.next;
    if (branchResolution.observationSnapshot) {
      iteration.observationSnapshot = branchResolution.observationSnapshot;
    }

    if (!branchResolution.selected) {
      iterations.push(iteration);
      return {
        maxIterations,
        iterations,
        stopReason: "no_branch_match"
      };
    }

    if (branchResolution.selected.actions.length > 0) {
      for (const action of branchResolution.selected.actions) {
        const result = await session.perform(action);
        iteration.selectedBranchActionResults.push(result);
      }
    }

    iterations.push(iteration);

    if (branchResolution.selected.next === "break") {
      return {
        maxIterations,
        iterations,
        stopReason: "branch_break"
      };
    }
  }

  return {
    maxIterations,
    iterations,
    stopReason: "max_iterations"
  };
}

async function resolveBranches(
  session: AgentSession,
  branches: LoopBranch[],
  getObservationSnapshot: () => Promise<DomSnapshot>,
  captureObservationSnapshot: boolean
): Promise<{
  branchResults: LoopBranchResult[];
  selected?: {
    label: string;
    next: "continue" | "break";
    actions: Action[];
  };
  observationSnapshot?: DomSnapshot;
}> {
  const branchResults: LoopBranchResult[] = [];
  let selected:
    | {
        label: string;
        next: "continue" | "break";
        actions: Action[];
      }
    | undefined;
  let observationSnapshot: DomSnapshot | undefined;

  const getSnapshotWithCache = async (): Promise<DomSnapshot> => {
    const snapshot = await getObservationSnapshot();
    observationSnapshot = snapshot;
    return snapshot;
  };

  for (const [index, branch] of branches.entries()) {
    const label = branch.label?.trim() || `branch_${index + 1}`;
    const matchMode = branch.match ?? "all";
    const predicates = branch.when ?? [];

    const predicateResults: LoopPredicateResult[] = [];
    for (const predicate of predicates) {
      const result = await evaluatePredicate(session, predicate, getSnapshotWithCache);
      predicateResults.push(result);
    }

    const matched =
      predicates.length === 0
        ? true
        : matchMode === "any"
          ? predicateResults.some((result) => result.passed)
          : predicateResults.every((result) => result.passed);

    branchResults.push({
      label,
      matched,
      matchMode,
      predicates: predicateResults
    });

    if (!selected && matched) {
      selected = {
        label,
        next: branch.next ?? "continue",
        actions: branch.actions ?? []
      };
    }
  }

  if (captureObservationSnapshot && !observationSnapshot) {
    observationSnapshot = await getSnapshotWithCache();
  }

  return {
    branchResults,
    selected,
    observationSnapshot
  };
}

async function evaluatePredicate(
  session: AgentSession,
  predicate: LoopPredicate,
  getObservationSnapshot: () => Promise<DomSnapshot>
): Promise<LoopPredicateResult> {
  if (predicate.kind === "assert") {
    const assertResult = await session.perform({
      type: "assert",
      condition: predicate.condition,
      timeoutMs: predicate.timeoutMs
    });
    const rawPass = assertResult.status === "ok";
    const negated = predicate.negate ?? false;
    const passed = negated ? !rawPass : rawPass;
    return {
      kind: "assert",
      passed,
      negate: negated,
      detail: rawPass
        ? `assert:${predicate.condition.kind} passed`
        : `assert:${predicate.condition.kind} failed (${assertResult.error?.message ?? "unknown"})`
    };
  }

  const snapshot = await getObservationSnapshot();
  const raw = evaluateSnapshotPredicate(snapshot, predicate);
  const negated = predicate.negate ?? false;
  return {
    kind: "snapshot",
    passed: negated ? !raw.passed : raw.passed,
    negate: negated,
    detail: raw.detail
  };
}

function evaluateSnapshotPredicate(
  snapshot: DomSnapshot,
  predicate: Extract<LoopPredicate, { kind: "snapshot" }>
): { passed: boolean; detail: string } {
  const actual = getSnapshotField(snapshot, predicate.field);
  const operator = predicate.operator;

  if (operator === "contains") {
    const passed = String(actual).includes(String(predicate.value));
    return {
      passed,
      detail: `snapshot.${predicate.field} contains '${predicate.value}' => actual='${truncateDetail(String(actual))}'`
    };
  }

  if (operator === "equals") {
    const expected = normalizeComparableValue(actual, predicate.value);
    const passed = actual === expected;
    return {
      passed,
      detail: `snapshot.${predicate.field} equals '${expected}' => actual='${truncateDetail(String(actual))}'`
    };
  }

  if (operator === "not_equals") {
    const expected = normalizeComparableValue(actual, predicate.value);
    const passed = actual !== expected;
    return {
      passed,
      detail: `snapshot.${predicate.field} not_equals '${expected}' => actual='${truncateDetail(String(actual))}'`
    };
  }

  const left = Number(actual);
  const right = Number(predicate.value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return {
      passed: false,
      detail: `snapshot.${predicate.field} ${operator} '${predicate.value}' => non-numeric comparison`
    };
  }

  if (operator === "gt") {
    return {
      passed: left > right,
      detail: `snapshot.${predicate.field} gt ${right} => actual=${left}`
    };
  }

  if (operator === "gte") {
    return {
      passed: left >= right,
      detail: `snapshot.${predicate.field} gte ${right} => actual=${left}`
    };
  }

  if (operator === "lt") {
    return {
      passed: left < right,
      detail: `snapshot.${predicate.field} lt ${right} => actual=${left}`
    };
  }

  return {
    passed: left <= right,
    detail: `snapshot.${predicate.field} lte ${right} => actual=${left}`
  };
}

function normalizeComparableValue(actual: string | number, value: string | number): string | number {
  if (typeof actual === "number") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
  }

  return String(value);
}

function getSnapshotField(
  snapshot: DomSnapshot,
  field: "url" | "title" | "domHash" | "nodeCount" | "interactiveCount"
): string | number {
  if (field === "url") {
    return snapshot.url;
  }
  if (field === "title") {
    return snapshot.title;
  }
  if (field === "domHash") {
    return snapshot.domHash;
  }
  if (field === "nodeCount") {
    return snapshot.nodeCount;
  }
  return snapshot.interactiveCount;
}

function truncateDetail(input: string): string {
  if (input.length <= 120) {
    return input;
  }
  return `${input.slice(0, 117)}...`;
}
