import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { parseAction } from "./contracts.js";
import {
  applyDeterministicSettings,
  defaultDeterministicOptions,
  installLayoutShiftCapture
} from "./deterministic.js";
import { BrowserObserver, collectPerformanceMetrics } from "./observer.js";
import { diffSnapshots, takeDomSnapshot } from "./snapshot.js";
import type {
  Action,
  ActionResult,
  AgentNode,
  AgentSessionOptions,
  DomSnapshot,
  NodeTarget,
  ObserverEvent,
  SavedSession,
  SavedTrace,
  TraceTimelineEntry,
  TraceRecord,
  WaitCondition
} from "./types.js";

const DEFAULT_OPTIONS: Required<
  Pick<
    AgentSessionOptions,
    | "headed"
    | "deterministic"
    | "slowMoMs"
    | "viewportWidth"
    | "viewportHeight"
    | "actionTimeoutMs"
    | "stableWaitMs"
    | "captureScreenshots"
    | "artifactsDir"
  >
> = {
  headed: true,
  deterministic: true,
  slowMoMs: 0,
  viewportWidth: 1440,
  viewportHeight: 920,
  actionTimeoutMs: 10_000,
  stableWaitMs: 120,
  captureScreenshots: true,
  artifactsDir: ".agent-browser/artifacts"
};

interface MockRule {
  method?: string;
  matcher: RegExp;
  status: number;
  headers?: Record<string, string>;
  body: string;
  contentType: string;
}

interface LocatorCandidate {
  label: string;
  locator: Locator;
}

interface ResolvedLocator {
  targetLabel: string;
  candidates: LocatorCandidate[];
  node?: AgentNode;
}

export class AgentSession {
  readonly sessionId = randomUUID();
  readonly tabId = "tab_1";

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private observer: BrowserObserver | null = null;

  private actionCounter = 0;
  private lastSnapshot: DomSnapshot | null = null;
  private readonly traceRecords: TraceRecord[] = [];
  private readonly timelineEntries: TraceTimelineEntry[] = [];
  private readonly requiredOrigins = new Set<string>();
  private readonly mockRules: MockRule[] = [];
  private mockRoutingReady = false;

  constructor(private readonly options: AgentSessionOptions = {}) {}

  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: !(this.options.headed ?? DEFAULT_OPTIONS.headed),
      slowMo: this.options.slowMoMs ?? DEFAULT_OPTIONS.slowMoMs
    });

    this.context = await this.browser.newContext({
      viewport: {
        width: this.options.viewportWidth ?? DEFAULT_OPTIONS.viewportWidth,
        height: this.options.viewportHeight ?? DEFAULT_OPTIONS.viewportHeight
      },
      storageState: this.options.storageStatePath
    });

    this.page = await this.context.newPage();

    await installLayoutShiftCapture(this.page);
    if (this.options.deterministic ?? DEFAULT_OPTIONS.deterministic) {
      await applyDeterministicSettings(this.page, defaultDeterministicOptions);
    }

    const redaction = this.options.logRedactionPatterns ?? defaultRedactionPatterns();
    this.observer = new BrowserObserver(
      this.context,
      this.page,
      redaction,
      this.options.logNoiseFiltering ?? true
    );
    this.observer.start();

    this.lastSnapshot = await takeDomSnapshot(this.page);
  }

  subscribe(listener: (event: ObserverEvent) => void): () => void {
    if (!this.observer) {
      throw new Error("Session is not started");
    }
    return this.observer.subscribe(listener);
  }

  async perform(rawAction: Action): Promise<ActionResult> {
    const action = parseAction(rawAction) as Action;
    const page = this.requirePage();
    const observer = this.requireObserver();

    const startedAt = Date.now();
    const actionId = `action_${++this.actionCounter}`;
    const preSnapshot = this.lastSnapshot ?? (await takeDomSnapshot(page));

    let status: ActionResult["status"] = "ok";
    let resolvedNodeId: string | undefined;
    let error: ActionResult["error"] | undefined;

    try {
      const execution = await this.executeAction(action, preSnapshot);
      resolvedNodeId = execution.resolvedNodeId;
      await this.waitForStability(getActionTimeout(action));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      status = isRetryableError(message) ? "retryable_error" : "fatal_error";
      error = {
        message,
        stack: caught instanceof Error ? caught.stack : undefined
      };
    }

    let postSnapshot: DomSnapshot;
    try {
      postSnapshot = await takeDomSnapshot(page);
    } catch (captureError) {
      const message = captureError instanceof Error ? captureError.message : String(captureError);
      if (status === "ok") {
        status = "retryable_error";
      }
      error = appendError(error, `Post-action snapshot failed: ${message}`);
      postSnapshot = {
        ...preSnapshot,
        snapshotId: randomUUID(),
        timestamp: Date.now(),
        url: safePageUrl(page, preSnapshot.url)
      };
    }

    this.lastSnapshot = postSnapshot;
    const domDiff = diffSnapshots(preSnapshot, postSnapshot);
    const events = observer.drain();
    let performance = defaultPerformanceMetrics();
    try {
      performance = await collectPerformanceMetrics(page);
    } catch (perfError) {
      const message = perfError instanceof Error ? perfError.message : String(perfError);
      error = appendError(error, `Performance capture failed: ${message}`);
    }

    let screenshotPath: string | undefined;
    try {
      screenshotPath = await this.captureScreenshot(actionId);
    } catch (shotError) {
      const message = shotError instanceof Error ? shotError.message : String(shotError);
      error = appendError(error, `Screenshot capture failed: ${message}`);
    }

    const finishedAt = Date.now();
    const result: ActionResult = {
      actionId,
      sessionId: this.sessionId,
      tabId: this.tabId,
      status,
      action,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      preSnapshot,
      postSnapshot,
      domDiff,
      events,
      performance,
      screenshotPath,
      resolvedNodeId,
      error
    };

    this.traceRecords.push({
      action,
      result: {
        status: result.status,
        postDomHash: result.postSnapshot.domHash,
        durationMs: result.durationMs,
        postUrl: result.postSnapshot.url,
        postTitle: result.postSnapshot.title,
        postInteractiveCount: result.postSnapshot.interactiveCount,
        waitForSelector: action.type === "waitFor" && action.condition.kind === "selector" ? action.condition.selector : undefined,
        networkErrorCount: result.events.filter(
          (event) => event.kind === "network" && event.phase === "request_failed"
        ).length,
        eventCount: result.events.length,
        errorMessage: result.error?.message
      }
    });

    this.timelineEntries.push({
      index: this.actionCounter - 1,
      actionType: action.type,
      status: result.status,
      durationMs: result.durationMs,
      postUrl: result.postSnapshot.url,
      postDomHash: result.postSnapshot.domHash,
      domDiffSummary: result.domDiff.summary,
      eventCount: result.events.length,
      screenshotPath: result.screenshotPath
    });

    noteOriginFromUrl(this.requiredOrigins, result.postSnapshot.url);
    if (action.type === "navigate") {
      noteOriginFromUrl(this.requiredOrigins, action.url);
    }

    return result;
  }

  async snapshot(): Promise<DomSnapshot> {
    const page = this.requirePage();
    this.lastSnapshot = await takeDomSnapshot(page);
    return this.lastSnapshot;
  }

  async saveTrace(filePath: string): Promise<string> {
    const absolutePath = resolve(filePath);
    await mkdir(dirname(absolutePath), { recursive: true });

    const trace: SavedTrace = {
      version: 2,
      createdAt: new Date().toISOString(),
      sessionId: this.sessionId,
      options: this.options,
      environment: {
        requiredOrigins: [...this.requiredOrigins].sort((left, right) => left.localeCompare(right))
      },
      timeline: [...this.timelineEntries],
      records: this.traceRecords
    };

    await writeFile(absolutePath, JSON.stringify(trace, null, 2), "utf8");
    return absolutePath;
  }

  async saveSession(name: string, rootDir = ".agent-browser/sessions"): Promise<string> {
    const context = this.requireContext();
    const page = this.requirePage();

    const dir = resolve(rootDir, name);
    await mkdir(dir, { recursive: true });

    const storageStatePath = join(dir, "storage-state.json");
    await context.storageState({ path: storageStatePath });

    const manifestPath = join(dir, "session.json");
    const manifest: SavedSession = {
      version: 1,
      createdAt: new Date().toISOString(),
      name,
      url: page.url(),
      storageStatePath
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    return manifestPath;
  }

  static async loadSavedSession(
    name: string,
    options: AgentSessionOptions = {},
    rootDir = ".agent-browser/sessions"
  ): Promise<AgentSession> {
    const manifestPath = resolve(rootDir, name, "session.json");
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as SavedSession;

    const session = new AgentSession({
      ...options,
      storageStatePath: manifest.storageStatePath
    });

    await session.start();
    await session.perform({ type: "navigate", url: manifest.url, waitUntil: "domcontentloaded" });
    return session;
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.context = null;
    this.browser = null;
    this.page = null;
    this.observer = null;
  }

  private async executeAction(action: Action, preSnapshot: DomSnapshot): Promise<{ resolvedNodeId?: string }> {
    const page = this.requirePage();

    switch (action.type) {
      case "navigate": {
        await page.goto(action.url, {
          waitUntil: action.waitUntil ?? "domcontentloaded",
          timeout: action.timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs
        });
        return {};
      }

      case "click": {
        const resolved = await this.resolveLocator(action.nodeId, action.target, preSnapshot);
        const timeout = action.timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;
        await this.runLocatorAction(
          resolved,
          timeout,
          async (locator, attemptTimeout) => {
            await locator.click({ timeout: attemptTimeout });
          }
        );
        return { resolvedNodeId: resolved.node?.id };
      }

      case "fill": {
        const resolved = await this.resolveLocator(action.nodeId, action.target, preSnapshot);
        const timeout = action.timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;
        await this.runLocatorAction(
          resolved,
          timeout,
          async (locator, attemptTimeout) => {
            await locator.fill(action.value, { timeout: attemptTimeout });
          }
        );
        return { resolvedNodeId: resolved.node?.id };
      }

      case "select": {
        const resolved = await this.resolveLocator(action.nodeId, action.target, preSnapshot);
        const timeout = action.timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;
        await this.runLocatorAction(
          resolved,
          timeout,
          async (locator, attemptTimeout) => {
            await locator.selectOption(action.value, { timeout: attemptTimeout });
          }
        );
        return { resolvedNodeId: resolved.node?.id };
      }

      case "press": {
        await page.keyboard.press(action.key);
        return {};
      }

      case "waitFor": {
        await this.runWaitCondition(action.condition, action.timeoutMs);
        return {};
      }

      case "snapshot": {
        await this.snapshot();
        return {};
      }

      case "setViewport": {
        await page.setViewportSize({ width: action.width, height: action.height });
        return {};
      }

      case "mock": {
        await this.addMockRoute(action.route);
        return {};
      }

      default: {
        const neverAction: never = action;
        throw new Error(`Unsupported action: ${JSON.stringify(neverAction)}`);
      }
    }
  }

  private async resolveLocator(
    nodeId: string | undefined,
    target: NodeTarget | undefined,
    snapshot: DomSnapshot
  ): Promise<ResolvedLocator> {
    const page = this.requirePage();

    if (nodeId) {
      const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        throw new Error(`Node '${nodeId}' was not found in snapshot`);
      }

      return {
        targetLabel: `nodeId:${nodeId}`,
        candidates: this.locatorCandidatesForNode(page, node),
        node
      };
    }

    if (!target) {
      throw new Error("Target is required when nodeId is not provided");
    }

    if (target.kind === "node") {
      return this.resolveLocator(target.nodeId, undefined, snapshot);
    }

    if (target.kind === "stableRef") {
      const matches = snapshot.nodes.filter((candidate) => candidate.stableRef === target.value);
      if (matches.length === 0) {
        throw new Error(`No node found with stableRef '${target.value}'`);
      }

      const ranked = rankStableRefMatches(matches);
      const candidates: LocatorCandidate[] = [];
      for (const match of ranked) {
        candidates.push(...this.locatorCandidatesForNode(page, match));
      }

      const selectedNode = ranked[0];
      return {
        targetLabel: `stableRef:${target.value}`,
        candidates: dedupeLocatorCandidates(candidates),
        node: selectedNode
      };
    }

    if (target.kind === "roleName") {
      const roleMatches = snapshot.nodes.filter(
        (node) =>
          node.role === target.role &&
          normalizeComparableText(node.name) === normalizeComparableText(target.name)
      );

      const rankedMatches = rankStableRefMatches(roleMatches);
      const roleCandidates: LocatorCandidate[] = [];
      for (const match of rankedMatches) {
        roleCandidates.push(...this.locatorCandidatesForNode(page, match));
      }

      roleCandidates.push({
        label: `getByRole(${target.role}, ${target.name}, exact=true)`,
        locator: page
          .getByRole(target.role as Parameters<Page["getByRole"]>[0], {
            name: target.name,
            exact: true
          })
          .first()
      });

      roleCandidates.push({
        label: `getByRole(${target.role}, ${target.name}, exact=false)`,
        locator: page
          .getByRole(target.role as Parameters<Page["getByRole"]>[0], {
            name: target.name
          })
          .first()
      });

      return {
        targetLabel: `roleName:${target.role}:${target.name}`,
        candidates: dedupeLocatorCandidates(roleCandidates)
      };
    }

    return {
      targetLabel: `css:${target.selector}`,
      candidates: [
        {
          label: `css:${target.selector}`,
          locator: page.locator(target.selector).first()
        }
      ]
    };
  }

  private locatorCandidatesForNode(page: Page, node: AgentNode): LocatorCandidate[] {
    const candidates: LocatorCandidate[] = [];

    const testId = node.attributes["data-testid"];
    if (testId) {
      candidates.push({
        label: `testId:${testId}`,
        locator: page.getByTestId(testId).first()
      });
    }

    const id = node.attributes.id;
    if (id) {
      candidates.push({
        label: `id:${id}`,
        locator: page.locator(`#${escapeForCss(id)}`).first()
      });
    }

    const href = node.attributes.href;
    if (href) {
      candidates.push({
        label: `href:${href}`,
        locator: page.locator(`a[href="${escapeAttributeValue(href)}"]`).first()
      });
    }

    const nameAttribute = node.attributes.name;
    if (nameAttribute) {
      candidates.push({
        label: `${node.tag}[name=${nameAttribute}]`,
        locator: page.locator(`${node.tag}[name="${escapeAttributeValue(nameAttribute)}"]`).first()
      });
    }

    if (node.role !== "generic" && node.name) {
      candidates.push({
        label: `role:${node.role} name:${node.name}`,
        locator: page
          .getByRole(node.role as Parameters<Page["getByRole"]>[0], {
            name: node.name
          })
          .first()
      });
    }

    candidates.push({
      label: `path:${node.path}`,
      locator: page.locator(node.path).first()
    });

    return dedupeLocatorCandidates(candidates);
  }

  private async runLocatorAction(
    resolved: ResolvedLocator,
    timeoutMs: number,
    run: (locator: Locator, timeoutMs: number) => Promise<void>
  ): Promise<void> {
    const errors: string[] = [];

    const perAttemptTimeout = Math.max(
      1_500,
      Math.floor(timeoutMs / Math.max(1, resolved.candidates.length))
    );

    for (const candidate of resolved.candidates) {
      try {
        await run(candidate.locator, perAttemptTimeout);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
        errors.push(`${candidate.label}: ${message}`);
      }
    }

    const detail = errors.map((entry) => `- ${entry}`).join("\n");
    throw new Error(
      [`Unable to resolve actionable locator for ${resolved.targetLabel}.`, detail].join("\n")
    );
  }

  private async runWaitCondition(condition: WaitCondition, timeoutMs?: number): Promise<void> {
    const page = this.requirePage();
    const timeout = timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;

    if (condition.kind === "timeout") {
      await page.waitForTimeout(condition.ms);
      return;
    }

    if (condition.kind === "selector") {
      await page.waitForSelector(condition.selector, {
        state: condition.state ?? "visible",
        timeout
      });
      return;
    }

    await page.waitForLoadState("networkidle", { timeout });
  }

  private async waitForStability(timeoutMs?: number): Promise<void> {
    const page = this.requirePage();
    const actionTimeout = timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;
    const quietWindowMs = this.options.stableWaitMs ?? DEFAULT_OPTIONS.stableWaitMs;
    const networkIdleBudgetMs = computeNetworkIdleBudgetMs(actionTimeout, quietWindowMs);

    await page.waitForTimeout(quietWindowMs);
    await page.waitForLoadState("networkidle", { timeout: networkIdleBudgetMs }).catch(() => undefined);
  }

  private async captureScreenshot(actionId: string): Promise<string | undefined> {
    if (!(this.options.captureScreenshots ?? DEFAULT_OPTIONS.captureScreenshots)) {
      return undefined;
    }

    const page = this.requirePage();
    const filePath = resolve(
      this.options.artifactsDir ?? DEFAULT_OPTIONS.artifactsDir,
      this.sessionId,
      `${String(this.actionCounter).padStart(4, "0")}-${actionId}.png`
    );

    await mkdir(dirname(filePath), { recursive: true });
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  }

  private async addMockRoute(route: Extract<Action, { type: "mock" }>["route"]): Promise<void> {
    await this.ensureMockRouting();

    this.mockRules.push({
      method: route.method?.toUpperCase(),
      matcher: globPatternToRegExp(route.urlPattern),
      status: route.status ?? 200,
      headers: route.headers,
      body: route.body ?? (route.json !== undefined ? JSON.stringify(route.json) : ""),
      contentType: route.contentType ?? (route.json !== undefined ? "application/json" : "text/plain")
    });
  }

  private async ensureMockRouting(): Promise<void> {
    if (this.mockRoutingReady) {
      return;
    }

    const context = this.requireContext();
    await context.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();
      const url = request.url();

      for (const rule of this.mockRules) {
        if (rule.method && method !== rule.method) {
          continue;
        }
        if (!rule.matcher.test(url)) {
          continue;
        }

        await route.fulfill({
          status: rule.status,
          body: rule.body,
          headers: {
            "content-type": rule.contentType,
            ...(rule.headers ?? {})
          }
        });
        return;
      }

      await route.continue();
    });

    this.mockRoutingReady = true;
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error("Session not started; call start() first");
    }
    return this.page;
  }

  private requireContext(): BrowserContext {
    if (!this.context) {
      throw new Error("Session not started; call start() first");
    }
    return this.context;
  }

  private requireObserver(): BrowserObserver {
    if (!this.observer) {
      throw new Error("Observer not initialized; call start() first");
    }
    return this.observer;
  }
}

function defaultRedactionPatterns(): RegExp[] {
  return [
    /bearer\s+[a-z0-9._-]+/gi,
    /("password"\s*:\s*")[^"]+"/gi,
    /(token=)[^&\s]+/gi,
    /(authorization:\s*)[^\s]+/gi
  ];
}

function escapeForCss(value: string): string {
  return value.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function globPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE_STAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE_STAR::/g, ".*");

  return new RegExp(`^${escaped}$`);
}

function isRetryableError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes("timeout") ||
    lowered.includes("target closed") ||
    lowered.includes("net::err") ||
    lowered.includes("navigation")
  );
}

function getActionTimeout(action: Action): number | undefined {
  if ("timeoutMs" in action) {
    return action.timeoutMs;
  }
  return undefined;
}

function defaultPerformanceMetrics(): ActionResult["performance"] {
  return {
    domContentLoadedMs: null,
    loadMs: null,
    firstPaintMs: null,
    firstContentfulPaintMs: null,
    layoutShiftScore: 0
  };
}

function appendError(
  existing: ActionResult["error"] | undefined,
  message: string
): ActionResult["error"] {
  if (!existing) {
    return { message };
  }
  return {
    message: `${existing.message}; ${message}`,
    stack: existing.stack
  };
}

function safePageUrl(page: Page, fallback: string): string {
  try {
    return page.url();
  } catch {
    return fallback;
  }
}

function dedupeLocatorCandidates(candidates: LocatorCandidate[]): LocatorCandidate[] {
  const seen = new Set<string>();
  const deduped: LocatorCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.label)) {
      continue;
    }
    seen.add(candidate.label);
    deduped.push(candidate);
  }

  return deduped;
}

function rankStableRefMatches(nodes: AgentNode[]): AgentNode[] {
  return [...nodes].sort((left, right) => {
    const leftScore = scoreNodeForInteraction(left);
    const rightScore = scoreNodeForInteraction(right);
    return rightScore - leftScore;
  });
}

function scoreNodeForInteraction(node: AgentNode): number {
  let score = 0;
  if (node.visible) {
    score += 4;
  }
  if (node.enabled) {
    score += 2;
  }
  if (node.interactive) {
    score += 2;
  }
  if (node.boundingBox.width > 0 && node.boundingBox.height > 0) {
    score += 1;
  }
  return score;
}

function normalizeComparableText(input: string): string {
  return input.replace(/\s+/g, " ").trim().toLowerCase();
}

export function computeNetworkIdleBudgetMs(actionTimeoutMs: number, quietWindowMs: number): number {
  const quarter = Math.floor(actionTimeoutMs / 4);
  const floor = Math.max(quietWindowMs, 400);
  return Math.min(2_000, Math.max(floor, quarter));
}

function noteOriginFromUrl(origins: Set<string>, input: string): void {
  try {
    const url = new URL(input);
    if (url.protocol === "http:" || url.protocol === "https:") {
      origins.add(url.origin);
    }
  } catch {
    // Ignore malformed URLs.
  }
}
