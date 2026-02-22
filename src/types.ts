export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AgentNode {
  id: string;
  stableRef: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  value: string;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  interactive: boolean;
  boundingBox: BoundingBox;
  path: string;
  attributes: Record<string, string>;
}

export interface DomSnapshot {
  snapshotId: string;
  timestamp: number;
  url: string;
  title: string;
  domHash: string;
  viewport: {
    width: number;
    height: number;
  };
  nodeCount: number;
  interactiveCount: number;
  nodes: AgentNode[];
}

export interface NodeChange {
  field: "text" | "value" | "visible" | "enabled" | "name";
  before: string | boolean;
  after: string | boolean;
}

export interface ChangedNode {
  id: string;
  stableRef: string;
  changes: NodeChange[];
}

export interface DomDiffSummary {
  added: number;
  removed: number;
  changed: number;
}

export interface DomDiff {
  beforeSnapshotId: string;
  afterSnapshotId: string;
  added: AgentNode[];
  removed: AgentNode[];
  changed: ChangedNode[];
  summary: DomDiffSummary;
}

export type ConsoleLevel = "log" | "debug" | "info" | "warn" | "error";

export interface BaseEvent {
  seq: number;
  timestamp: number;
}

export interface ConsoleEvent extends BaseEvent {
  kind: "console";
  level: ConsoleLevel;
  text: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

export interface PageErrorEvent extends BaseEvent {
  kind: "page_error";
  message: string;
  stack?: string;
}

export interface NetworkEvent extends BaseEvent {
  kind: "network";
  phase: "request" | "response" | "request_failed";
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  failureText?: string;
}

export type ObserverEvent = ConsoleEvent | PageErrorEvent | NetworkEvent;

export interface PerformanceMetrics {
  domContentLoadedMs: number | null;
  loadMs: number | null;
  firstPaintMs: number | null;
  firstContentfulPaintMs: number | null;
  layoutShiftScore: number;
}

export type ActionStatus = "ok" | "retryable_error" | "fatal_error";

export type RetryFinalReason =
  | "succeeded"
  | "max_attempts_reached"
  | "non_retryable_error"
  | "retry_disabled";

export interface RetryAttemptEvidence {
  attempt: number;
  actionId: string;
  status: ActionStatus;
  durationMs: number;
  postUrl: string;
  postDomHash: string;
  eventCount: number;
  errorMessage?: string;
  screenshotPath?: string;
  annotatedScreenshotPath?: string;
}

export interface RetrySummary {
  enabled: boolean;
  maxAttempts: number;
  attemptCount: number;
  backoffMs: number;
  finalReason: RetryFinalReason;
  attempts: RetryAttemptEvidence[];
}

export type NodeTarget =
  | {
      kind: "node";
      nodeId: string;
    }
  | {
      kind: "stableRef";
      value: string;
    }
  | {
      kind: "roleName";
      role: string;
      name: string;
    }
  | {
      kind: "css";
      selector: string;
    };

export interface NavigateAction {
  type: "navigate";
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
}

export interface ClickAction {
  type: "click";
  nodeId?: string;
  target?: NodeTarget;
  timeoutMs?: number;
}

export interface FillAction {
  type: "fill";
  value: string;
  nodeId?: string;
  target?: NodeTarget;
  timeoutMs?: number;
}

export interface SelectAction {
  type: "select";
  value: string;
  nodeId?: string;
  target?: NodeTarget;
  timeoutMs?: number;
}

export interface PressAction {
  type: "press";
  key: string;
  timeoutMs?: number;
}

export interface PauseAction {
  type: "pause";
  mode?: "enter" | "timeout";
  timeoutMs?: number;
  note?: string;
}

export type AssertCondition =
  | {
      kind: "selector";
      selector: string;
      state?: "attached" | "detached" | "visible" | "hidden";
      textContains?: string;
    }
  | {
      kind: "selector_bbox_min";
      selector: string;
      minWidth: number;
      minHeight: number;
      requireCount?: number;
    }
  | {
      kind: "selector_overlap_max";
      selectorA: string;
      selectorB: string;
      maxOverlapRatio: number;
    }
  | {
      kind: "url_contains";
      value: string;
    }
  | {
      kind: "title_contains";
      value: string;
    }
  | {
      kind: "visual_baseline";
      baselinePath: string;
      maxMismatchRatio?: number;
      threshold?: number;
      diffPath?: string;
    };

export interface AssertAction {
  type: "assert";
  condition: AssertCondition;
  timeoutMs?: number;
}

export interface HandleConsentAction {
  type: "handleConsent";
  mode?: "accept" | "reject";
  requireFound?: boolean;
  strategy?: "auto" | "generic" | "cmp";
  siteAdapter?: string;
  region?: "auto" | "global" | "eu" | "us" | "uk";
  timeoutMs?: number;
}

export type WaitCondition =
  | {
      kind: "timeout";
      ms: number;
    }
  | {
      kind: "selector";
      selector: string;
      state?: "attached" | "detached" | "visible" | "hidden";
    }
  | {
      kind: "network_idle";
    }
  | {
      kind: "network_response";
      urlContains?: string;
      urlMatches?: string;
      method?: string;
      status?: number;
      statusMin?: number;
      statusMax?: number;
      bodyIncludes?: string;
      bodyMatches?: string;
      ignoreCase?: boolean;
    };

export interface WaitForAction {
  type: "waitFor";
  condition: WaitCondition;
  timeoutMs?: number;
}

export interface SnapshotAction {
  type: "snapshot";
}

export interface SetViewportAction {
  type: "setViewport";
  width: number;
  height: number;
}

export interface SwitchProfileAction {
  type: "switchProfile";
  profile: string;
  profilesRoot?: string;
  url?: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  timeoutMs?: number;
}

export interface MockRouteAction {
  type: "mock";
  route: {
    method?: string;
    urlPattern: string;
    status?: number;
    headers?: Record<string, string>;
    contentType?: string;
    body?: string;
    json?: unknown;
  };
}

export interface CheckpointAction {
  type: "checkpoint";
  name: string;
  rootDir?: string;
}

export type Action =
  | NavigateAction
  | ClickAction
  | FillAction
  | SelectAction
  | PressAction
  | PauseAction
  | AssertAction
  | HandleConsentAction
  | WaitForAction
  | SnapshotAction
  | SetViewportAction
  | SwitchProfileAction
  | MockRouteAction
  | CheckpointAction;

export interface ActionResult {
  actionId: string;
  sessionId: string;
  tabId: string;
  status: ActionStatus;
  action: Action;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  preSnapshot: DomSnapshot;
  postSnapshot: DomSnapshot;
  domDiff: DomDiff;
  events: ObserverEvent[];
  performance: PerformanceMetrics;
  screenshotPath?: string;
  annotatedScreenshotPath?: string;
  resolvedNodeId?: string;
  resolvedBoundingBox?: BoundingBox;
  selectorDiagnostics?: {
    targetLabel: string;
    candidateCount: number;
    selectedCandidateIndex?: number;
    selectedCandidateLabel?: string;
    attemptedCandidateCount: number;
  };
  pauseSummary?: {
    mode: "enter" | "timeout";
    note?: string;
    elapsedMs: number;
    urlChanged: boolean;
    domChanged: boolean;
  };
  checkpointSummary?: {
    name: string;
    manifestPath: string;
  };
  retry?: RetrySummary;
  error?: {
    message: string;
    stack?: string;
  };
}

export interface TraceRecord {
  action: Action;
  result: {
    status: ActionStatus;
    postDomHash: string;
    durationMs: number;
    postUrl?: string;
    postTitle?: string;
    postInteractiveCount?: number;
    waitForSelector?: string;
    selectorTarget?: string;
    selectorCandidateCount?: number;
    selectorFallbackDepth?: number;
    selectorAttemptedCount?: number;
    selectorSelectedCandidate?: string;
    networkErrorCount?: number;
    eventCount?: number;
    errorMessage?: string;
    retryAttemptCount?: number;
    retryMaxAttempts?: number;
    retryFinalReason?: RetryFinalReason;
    retryAttemptStatuses?: ActionStatus[];
    retryAttemptDurationsMs?: number[];
    checkpointName?: string;
    checkpointManifestPath?: string;
  };
}

export interface TraceEnvironment {
  requiredOrigins: string[];
}

export interface TraceTimelineEntry {
  index: number;
  actionType: Action["type"] | "pause_start" | "pause_resume";
  status: ActionStatus;
  durationMs: number;
  postUrl: string;
  postDomHash: string;
  domDiffSummary: DomDiffSummary;
  eventCount: number;
  screenshotPath?: string;
  annotatedScreenshotPath?: string;
  target?: {
    nodeId?: string;
    stableRef?: string;
    role?: string;
    name?: string;
    boundingBox?: BoundingBox;
  };
  control?: {
    phase: "start" | "resume";
    elapsedMs?: number;
    sources: string[];
    urlChanged?: boolean;
    domChanged?: boolean;
    hints?: string[];
  };
  retry?: {
    attemptCount: number;
    maxAttempts: number;
    backoffMs: number;
    finalReason: RetryFinalReason;
    attemptStatuses: ActionStatus[];
    attemptDurationsMs: number[];
  };
  checkpoint?: {
    name: string;
    manifestPath: string;
  };
}

export interface InterventionJournalEntry {
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  sources: string[];
  preUrl: string;
  postUrl: string;
  preDomHash: string;
  postDomHash: string;
  urlChanged: boolean;
  domChanged: boolean;
  severity: "low" | "high";
  storageDelta?: {
    cookies: {
      added: string[];
      removed: string[];
      changed: string[];
      truncated: boolean;
    };
    localStorage: {
      added: string[];
      removed: string[];
      changed: string[];
      truncated: boolean;
    };
  };
  reconciliationHints?: string[];
}

export interface SavedTrace {
  version: 1 | 2;
  createdAt: string;
  sessionId: string;
  options: AgentSessionOptions;
  environment?: TraceEnvironment;
  timeline?: TraceTimelineEntry[];
  interventions?: InterventionJournalEntry[];
  records: TraceRecord[];
}

export interface SavedSession {
  version: 1;
  createdAt: string;
  name: string;
  url: string;
  storageStatePath: string;
}

export interface AgentSessionOptions {
  headed?: boolean;
  browserOverlay?: boolean;
  deterministic?: boolean;
  slowMoMs?: number;
  stabilityProfile?: "fast" | "balanced" | "chatty";
  screenshotMode?: "viewport" | "fullpage";
  annotateScreenshots?: boolean;
  redactionPack?: "default" | "strict" | "off";
  viewportWidth?: number;
  viewportHeight?: number;
  actionTimeoutMs?: number;
  stableWaitMs?: number;
  captureScreenshots?: boolean;
  artifactsDir?: string;
  contextAttachments?: boolean;
  contextAttachmentsDir?: string;
  maxInterventionsRetained?: number;
  interventionRetentionMode?: "count" | "severity";
  interventionSourceQuotas?: Record<string, number>;
  maxActionAttempts?: number;
  retryBackoffMs?: number;
  storageStatePath?: string;
  logRedactionPatterns?: RegExp[];
  logNoiseFiltering?: boolean;
}

export type SuggestedAction = "click" | "fill" | "select";

export interface AgentElementDescription {
  id: string;
  stableRef: string;
  role: string;
  name: string;
  text: string;
  bbox: BoundingBox;
  inViewport: boolean;
  visible: boolean;
  enabled: boolean;
  interactive: boolean;
  location: string;
  suggestedActions: SuggestedAction[];
  confidenceScore: number;
  confidenceReasons: string[];
}

export interface AgentPageDescription {
  snapshotId: string;
  url: string;
  title: string;
  domHash: string;
  viewport: {
    width: number;
    height: number;
  };
  summary: string;
  interactiveElements: AgentElementDescription[];
  potentialIssues: string[];
  screenshotPath?: string;
}

export interface ActionScript {
  settings?: Partial<AgentSessionOptions>;
  actions: Action[];
}

export type LoopPredicate =
  | {
      kind: "snapshot";
      field: "url" | "title" | "domHash" | "nodeCount" | "interactiveCount";
      operator: "contains" | "equals" | "not_equals" | "gt" | "gte" | "lt" | "lte";
      value: string | number;
      negate?: boolean;
    }
  | {
      kind: "assert";
      condition: AssertCondition;
      timeoutMs?: number;
      negate?: boolean;
    };

export interface LoopBranch {
  label?: string;
  match?: "all" | "any";
  when?: LoopPredicate[];
  actions?: Action[];
  next?: "continue" | "break";
}

export interface LoopScript {
  settings?: Partial<AgentSessionOptions>;
  setupActions?: Action[];
  stepAction: Action;
  branches: LoopBranch[];
  maxIterations?: number;
  continueOnStepError?: boolean;
  captureObservationSnapshot?: boolean;
}

export interface LoopPredicateResult {
  kind: LoopPredicate["kind"];
  passed: boolean;
  negate: boolean;
  detail: string;
}

export interface LoopBranchResult {
  label: string;
  matched: boolean;
  matchMode: "all" | "any";
  predicates: LoopPredicateResult[];
}

export interface LoopIterationResult {
  iteration: number;
  stepResult: ActionResult;
  branchResults: LoopBranchResult[];
  selectedBranchLabel?: string;
  selectedBranchNext?: "continue" | "break";
  selectedBranchActionResults: ActionResult[];
  observationSnapshot?: DomSnapshot;
}

export interface LoopRunReport {
  maxIterations: number;
  iterations: LoopIterationResult[];
  stopReason: "branch_break" | "no_branch_match" | "max_iterations" | "step_error";
}

export interface SelectorHealthTopTarget {
  target: string;
  total: number;
  failures: number;
  timeouts: number;
  avgFallbackDepth: number;
}

export interface SelectorHealthReport {
  createdAt: string;
  tracePath?: string;
  totals: {
    selectorActions: number;
    fallbackUsed: number;
    ambiguous: number;
    failures: number;
    timeoutFailures: number;
  };
  fallbackDepth: {
    average: number;
    max: number;
    histogram: Record<string, number>;
  };
  topTargets: SelectorHealthTopTarget[];
}

export interface RunArtifactIndex {
  version: 1;
  createdAt: string;
  tracePath: string;
  summary: {
    actions: number;
    failedActions: number;
  };
  selectorHealthPath?: string;
  timelineHtmlPaths: string[];
  bundleManifestPaths: string[];
  visualDiffReportPaths: string[];
  screenshots: string[];
  annotatedScreenshots: string[];
  topErrors: Array<{
    message: string;
    count: number;
    sampleActionType?: string;
    sampleIndex?: number;
  }>;
}

export interface ReplayReport {
  tracePath: string;
  mode: ReplayMode;
  totalActions: number;
  matched: number;
  mismatched: number;
  preflight: {
    checkedOrigins: string[];
    skipped: boolean;
  };
  invariants: {
    selectorEnabled: boolean;
    selectorChecks: number;
    selectorMismatches: number;
  };
  mismatches: Array<{
    index: number;
    reason: "dom_hash" | "status" | "url" | "selector_invariant";
    expected: string;
    actual: string;
    actionType: Action["type"];
  }>;
}

export type ReplayMode = "strict" | "relaxed";

export interface ReplayOptions {
  mode?: ReplayMode;
  preflight?: boolean;
  preflightTimeoutMs?: number;
  selectorInvariants?: boolean;
}

export interface FlakeReport {
  tracePath: string;
  runs: number;
  mode: ReplayMode;
  unstableActions: Array<{
    index: number;
    actionType: Action["type"];
    mismatchRuns: number;
  }>;
}

export interface VisualDiffEntry {
  index: number;
  actionType: Action["type"];
  baselineScreenshotPath?: string;
  candidateScreenshotPath?: string;
  status: "ok" | "different" | "missing_baseline" | "missing_candidate" | "size_mismatch";
  mismatchPixels: number;
  totalPixels: number;
  mismatchRatio: number;
  width?: number;
  height?: number;
  diffImagePath?: string;
  targetLabel?: string;
  baselineTargetBox?: BoundingBox;
  candidateTargetBox?: BoundingBox;
}

export interface VisualDiffReport {
  baselineTracePath: string;
  candidateTracePath: string;
  compared: number;
  different: number;
  missing: number;
  sizeMismatches: number;
  entries: VisualDiffEntry[];
}
