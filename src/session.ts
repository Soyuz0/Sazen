import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { annotateActionScreenshot } from "./annotate.js";
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
  BoundingBox,
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
    | "browserOverlay"
    | "deterministic"
    | "slowMoMs"
    | "stabilityProfile"
    | "screenshotMode"
    | "annotateScreenshots"
    | "redactionPack"
    | "viewportWidth"
    | "viewportHeight"
    | "actionTimeoutMs"
    | "stableWaitMs"
    | "captureScreenshots"
    | "artifactsDir"
  >
> = {
  headed: true,
  browserOverlay: true,
  deterministic: true,
  slowMoMs: 0,
  stabilityProfile: "balanced",
  screenshotMode: "viewport",
  annotateScreenshots: true,
  redactionPack: "default",
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
  private readonly executionPauseSources = new Set<string>();
  private executionPauseStartedAt: number | undefined;
  private executionPausedMsTotal = 0;
  private readonly executionResumeWaiters: Array<() => void> = [];

  constructor(private readonly options: AgentSessionOptions = {}) {}

  async start(): Promise<void> {
    const headed = this.options.headed ?? DEFAULT_OPTIONS.headed;
    this.browser = await chromium.launch({
      headless: !headed,
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

    if (this.options.browserOverlay ?? DEFAULT_OPTIONS.browserOverlay) {
      await this.installBrowserOverlay();
    }

    await installLayoutShiftCapture(this.page);
    if (this.options.deterministic ?? DEFAULT_OPTIONS.deterministic) {
      await applyDeterministicSettings(this.page, defaultDeterministicOptions);
    }

    const redaction =
      this.options.logRedactionPatterns ??
      defaultRedactionPatterns(this.options.redactionPack ?? DEFAULT_OPTIONS.redactionPack);
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

  pauseExecution(source = "api"): { paused: boolean; pausedMs: number; sources: string[] } {
    if (!this.executionPauseSources.has(source)) {
      if (this.executionPauseSources.size === 0) {
        this.executionPauseStartedAt = Date.now();
      }
      this.executionPauseSources.add(source);
    }

    return this.getExecutionControlState();
  }

  resumeExecution(source = "api"): { paused: boolean; pausedMs: number; sources: string[] } {
    if (this.executionPauseSources.delete(source) && this.executionPauseSources.size === 0) {
      const startedAt = this.executionPauseStartedAt ?? Date.now();
      this.executionPausedMsTotal += Math.max(0, Date.now() - startedAt);
      this.executionPauseStartedAt = undefined;
      const waiters = [...this.executionResumeWaiters];
      this.executionResumeWaiters.length = 0;
      for (const waiter of waiters) {
        waiter();
      }
    }

    return this.getExecutionControlState();
  }

  getExecutionControlState(): { paused: boolean; pausedMs: number; sources: string[] } {
    return {
      paused: this.executionPauseSources.size > 0,
      pausedMs: this.getExecutionPausedMs(),
      sources: [...this.executionPauseSources].sort((left, right) => left.localeCompare(right))
    };
  }

  async perform(rawAction: Action): Promise<ActionResult> {
    const action = parseAction(rawAction) as Action;
    const page = this.requirePage();
    const observer = this.requireObserver();
    await this.waitForExecutionResume();

    const startedAt = Date.now();
    const actionId = `action_${++this.actionCounter}`;
    const preSnapshot = this.lastSnapshot ?? (await takeDomSnapshot(page));

    let status: ActionResult["status"] = "ok";
    let resolvedNodeId: string | undefined;
    let resolvedBoundingBox: BoundingBox | undefined;
    let pauseElapsedMs: number | undefined;
    let error: ActionResult["error"] | undefined;

    try {
      const execution = await this.executeAction(action, preSnapshot);
      resolvedNodeId = execution.resolvedNodeId;
      resolvedBoundingBox = execution.resolvedBoundingBox;
      pauseElapsedMs = execution.pauseElapsedMs;
      await this.waitForStability(action, getActionTimeout(action));
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
    let annotatedScreenshotPath: string | undefined;
    try {
      screenshotPath = await this.captureScreenshot(actionId);
      if (screenshotPath && (this.options.annotateScreenshots ?? DEFAULT_OPTIONS.annotateScreenshots)) {
        try {
          annotatedScreenshotPath = await annotateActionScreenshot({
            screenshotPath,
            action,
            resolvedNodeId,
            resolvedBoundingBox,
            snapshot: preSnapshot
          });
        } catch (annotationError) {
          const message = annotationError instanceof Error ? annotationError.message : String(annotationError);
          error = appendError(error, `Screenshot annotation failed: ${message}`);
        }
      }
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
      annotatedScreenshotPath,
      resolvedNodeId,
      resolvedBoundingBox,
      pauseSummary:
        action.type === "pause"
          ? {
              mode: action.mode ?? "enter",
              note: action.note,
              elapsedMs: pauseElapsedMs ?? finishedAt - startedAt,
              urlChanged: preSnapshot.url !== postSnapshot.url,
              domChanged: postSnapshot.domHash !== preSnapshot.domHash
            }
          : undefined,
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
        waitForSelector: extractSelectorInvariant(action),
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
      screenshotPath: result.screenshotPath,
      annotatedScreenshotPath: result.annotatedScreenshotPath
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

  private async executeAction(
    action: Action,
    preSnapshot: DomSnapshot
  ): Promise<{ resolvedNodeId?: string; resolvedBoundingBox?: BoundingBox; pauseElapsedMs?: number }> {
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
        const execution = await this.runLocatorAction(
          resolved,
          timeout,
          async (locator, attemptTimeout) => {
            await locator.click({ timeout: attemptTimeout });
          }
        );
        return {
          resolvedNodeId: resolved.node?.id,
          resolvedBoundingBox: execution.resolvedBoundingBox
        };
      }

      case "fill": {
        const resolved = await this.resolveLocator(action.nodeId, action.target, preSnapshot);
        const timeout = action.timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;
        const execution = await this.runLocatorAction(
          resolved,
          timeout,
          async (locator, attemptTimeout) => {
            await locator.fill(action.value, { timeout: attemptTimeout });
          }
        );
        return {
          resolvedNodeId: resolved.node?.id,
          resolvedBoundingBox: execution.resolvedBoundingBox
        };
      }

      case "select": {
        const resolved = await this.resolveLocator(action.nodeId, action.target, preSnapshot);
        const timeout = action.timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;
        const execution = await this.runLocatorAction(
          resolved,
          timeout,
          async (locator, attemptTimeout) => {
            await locator.selectOption(action.value, { timeout: attemptTimeout });
          }
        );
        return {
          resolvedNodeId: resolved.node?.id,
          resolvedBoundingBox: execution.resolvedBoundingBox
        };
      }

      case "press": {
        await page.keyboard.press(action.key);
        return {};
      }

      case "pause": {
        const elapsedMs = await this.runPauseAction(action);
        return {
          pauseElapsedMs: elapsedMs
        };
      }

      case "assert": {
        await this.runAssertAction(action);
        return {};
      }

      case "handleConsent": {
        await this.handleConsent(action);
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
  ): Promise<{ resolvedBoundingBox?: BoundingBox }> {
    const errors: string[] = [];

    const perAttemptTimeout = Math.max(
      1_500,
      Math.floor(timeoutMs / Math.max(1, resolved.candidates.length))
    );

    for (const candidate of resolved.candidates) {
      try {
        const box = await candidate.locator.boundingBox().catch(() => null);
        await run(candidate.locator, perAttemptTimeout);
        return {
          resolvedBoundingBox: box
            ? {
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height
              }
            : undefined
        };
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

  private async runAssertAction(action: Extract<Action, { type: "assert" }>): Promise<void> {
    const page = this.requirePage();
    const timeout = action.timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;

    if (action.condition.kind === "selector") {
      const state = action.condition.state ?? "visible";
      const locator = page.locator(action.condition.selector).first();
      await locator.waitFor({ state, timeout });

      if (action.condition.textContains) {
        const text = await locator.innerText({ timeout });
        if (!text.includes(action.condition.textContains)) {
          throw new Error(
            `Assert failed: selector '${action.condition.selector}' text does not include '${action.condition.textContains}'`
          );
        }
      }

      return;
    }

    if (action.condition.kind === "selector_bbox_min") {
      const condition = action.condition;
      const selector = condition.selector;
      const locator = page.locator(selector);
      await locator.first().waitFor({ state: "attached", timeout });
      const boxes = await locator.evaluateAll((elements) =>
        elements
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              visible:
                rect.width > 0 &&
                rect.height > 0 &&
                getComputedStyle(element).display !== "none" &&
                getComputedStyle(element).visibility !== "hidden"
            };
          })
          .filter((entry) => entry.visible)
      );

      const passing = boxes.filter(
        (entry) => entry.width >= condition.minWidth && entry.height >= condition.minHeight
      ).length;
      const requiredCount = condition.requireCount ?? 1;

      if (passing < requiredCount) {
        throw new Error(
          `Assert failed: selector '${selector}' has ${passing} visible nodes meeting min bbox ${condition.minWidth}x${condition.minHeight} (required ${requiredCount})`
        );
      }

      return;
    }

    if (action.condition.kind === "selector_overlap_max") {
      const [boxA, boxB] = await Promise.all([
        page.locator(action.condition.selectorA).first().boundingBox(),
        page.locator(action.condition.selectorB).first().boundingBox()
      ]);

      if (!boxA || !boxB) {
        throw new Error(
          `Assert failed: unable to get bounding boxes for '${action.condition.selectorA}' and '${action.condition.selectorB}'`
        );
      }

      const overlapRatio = calculateOverlapRatio(boxA, boxB);
      if (overlapRatio > action.condition.maxOverlapRatio) {
        throw new Error(
          `Assert failed: overlap ratio ${overlapRatio.toFixed(3)} exceeds max ${action.condition.maxOverlapRatio.toFixed(3)}`
        );
      }

      return;
    }

    if (action.condition.kind === "url_contains") {
      await page.waitForFunction(
        (needle) => window.location.href.includes(needle),
        action.condition.value,
        { timeout }
      );
      return;
    }

    await page.waitForFunction(
      (needle) => document.title.toLowerCase().includes(String(needle).toLowerCase()),
      action.condition.value,
      { timeout }
    );
  }

  private async handleConsent(action: Extract<Action, { type: "handleConsent" }>): Promise<void> {
    const page = this.requirePage();
    const timeout = action.timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;
    const mode = action.mode ?? "accept";

    const acceptNames = [
      /accept/i,
      /agree/i,
      /allow all/i,
      /allow cookies/i,
      /ok/i,
      /got it/i,
      /continue/i
    ];
    const rejectNames = [/reject/i, /decline/i, /deny/i, /necessary only/i];

    const names = mode === "accept" ? acceptNames : rejectNames;

    const selectorCandidates = [
      "button[data-testid*='accept']",
      "button[id*='accept']",
      "button[class*='accept']",
      "button[aria-label*='accept' i]",
      "button[data-testid*='reject']",
      "button[id*='reject']",
      "button[class*='reject']"
    ];

    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const namePattern of names) {
        const roleButton = page.getByRole("button", { name: namePattern }).first();
        if (await roleButton.isVisible().catch(() => false)) {
          await roleButton.click({ timeout: 1_500 });
          return;
        }

        const roleLink = page.getByRole("link", { name: namePattern }).first();
        if (await roleLink.isVisible().catch(() => false)) {
          await roleLink.click({ timeout: 1_500 });
          return;
        }
      }

      for (const selector of selectorCandidates) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) {
          await locator.click({ timeout: 1_500 });
          return;
        }
      }

      await page.waitForTimeout(250);
    }

    if (action.requireFound) {
      throw new Error(`No consent control found for mode '${mode}' within ${timeout}ms`);
    }
  }

  private async runPauseAction(action: Extract<Action, { type: "pause" }>): Promise<number> {
    const mode = action.mode ?? "enter";
    const timeout = action.timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;
    const startedAt = Date.now();

    if (mode === "timeout") {
      await this.requirePage().waitForTimeout(timeout);
      return Date.now() - startedAt;
    }

    await waitForEnterOrTimeout(timeout);
    return Date.now() - startedAt;
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

  private async waitForStability(action: Action, timeoutMs?: number): Promise<void> {
    const page = this.requirePage();
    const actionTimeout = timeoutMs ?? this.options.actionTimeoutMs ?? DEFAULT_OPTIONS.actionTimeoutMs;
    const profile = this.options.stabilityProfile ?? DEFAULT_OPTIONS.stabilityProfile;
    const baseQuietWindowMs = this.options.stableWaitMs ?? DEFAULT_OPTIONS.stableWaitMs;
    const quietWindowMs = computeQuietWindowMs(profile, baseQuietWindowMs);
    const networkIdleBudgetMs = computeNetworkIdleBudgetMs(profile, actionTimeout, quietWindowMs, action.type);

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
    await page.screenshot({
      path: filePath,
      fullPage: (this.options.screenshotMode ?? DEFAULT_OPTIONS.screenshotMode) === "fullpage"
    });
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

  private async installBrowserOverlay(): Promise<void> {
    const page = this.requirePage();

    await page.exposeBinding("__agentBrowserControl", async (_source, request: unknown) => {
      const command =
        typeof request === "object" && request !== null && "type" in request
          ? String((request as { type: unknown }).type)
          : "state";

      if (command === "pause") {
        return this.pauseExecution("overlay");
      }
      if (command === "resume") {
        return this.resumeExecution("overlay");
      }
      if (command === "state") {
        return this.getExecutionControlState();
      }

      throw new Error(`Unsupported overlay control command '${command}'`);
    });

    await page.addInitScript(() => {
      const globalState = window as Window & {
        __agentBrowserControl?: (request: { type: string }) => Promise<{
          paused?: boolean;
          pausedMs?: number;
        }>;
      };

      const rootAttr = "data-agent-browser-overlay";
      const rootValue = "root";

      const install = () => {
        if (document.querySelector(`[${rootAttr}='${rootValue}']`)) {
          return;
        }

        const root = document.createElement("div");
        root.setAttribute(rootAttr, rootValue);
        root.style.position = "fixed";
        root.style.top = "12px";
        root.style.right = "12px";
        root.style.zIndex = "2147483647";
        root.style.pointerEvents = "none";

        const panel = document.createElement("div");
        panel.style.pointerEvents = "auto";
        panel.style.display = "flex";
        panel.style.gap = "8px";
        panel.style.alignItems = "center";
        panel.style.padding = "8px 10px";
        panel.style.borderRadius = "10px";
        panel.style.background = "rgba(15, 23, 42, 0.9)";
        panel.style.color = "#f8fafc";
        panel.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
        panel.style.fontSize = "12px";
        panel.style.boxShadow = "0 8px 20px rgba(0,0,0,0.3)";

        const status = document.createElement("span");
        status.textContent = "running";
        status.style.minWidth = "88px";

        const pauseButton = document.createElement("button");
        pauseButton.type = "button";
        pauseButton.textContent = "Pause";
        pauseButton.style.border = "0";
        pauseButton.style.borderRadius = "6px";
        pauseButton.style.padding = "4px 8px";
        pauseButton.style.cursor = "pointer";
        pauseButton.style.fontFamily = "inherit";
        pauseButton.style.fontSize = "12px";
        pauseButton.style.background = "#e2e8f0";
        pauseButton.style.color = "#0f172a";

        const resumeButton = document.createElement("button");
        resumeButton.type = "button";
        resumeButton.textContent = "Resume";
        resumeButton.style.border = "0";
        resumeButton.style.borderRadius = "6px";
        resumeButton.style.padding = "4px 8px";
        resumeButton.style.cursor = "pointer";
        resumeButton.style.fontFamily = "inherit";
        resumeButton.style.fontSize = "12px";
        resumeButton.style.background = "#22c55e";
        resumeButton.style.color = "#052e16";

        const setPausedState = (paused: boolean, pausedMs: number) => {
          status.textContent = paused
            ? `paused (${Math.floor(Math.max(0, pausedMs) / 1000)}s)`
            : "running";
          pauseButton.disabled = paused;
          resumeButton.disabled = !paused;
          pauseButton.style.opacity = paused ? "0.5" : "1";
          resumeButton.style.opacity = paused ? "1" : "0.5";
        };

        const send = async (type: "pause" | "resume" | "state") => {
          if (!globalState.__agentBrowserControl) {
            return;
          }

          try {
            const state = await globalState.__agentBrowserControl({ type });
            setPausedState(Boolean(state?.paused), Number(state?.pausedMs ?? 0));
          } catch {
            // Ignore overlay update failures.
          }
        };

        pauseButton.addEventListener("click", () => {
          void send("pause");
        });
        resumeButton.addEventListener("click", () => {
          void send("resume");
        });

        panel.append(status, pauseButton, resumeButton);
        root.append(panel);
        document.documentElement.append(root);

        void send("state");
        window.setInterval(() => {
          void send("state");
        }, 1000);
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", install, { once: true });
      } else {
        install();
      }
    });

  }

  private async waitForExecutionResume(): Promise<void> {
    if (this.executionPauseSources.size === 0) {
      return;
    }

    await new Promise<void>((resolvePromise) => {
      if (this.executionPauseSources.size === 0) {
        resolvePromise();
        return;
      }
      this.executionResumeWaiters.push(resolvePromise);
    });
  }

  private getExecutionPausedMs(): number {
    if (this.executionPauseSources.size === 0 || !this.executionPauseStartedAt) {
      return this.executionPausedMsTotal;
    }
    return this.executionPausedMsTotal + Math.max(0, Date.now() - this.executionPauseStartedAt);
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

function defaultRedactionPatterns(pack: AgentSessionOptions["redactionPack"]): RegExp[] {
  if (pack === "off") {
    return [];
  }

  const base = [
    /bearer\s+[a-z0-9._-]+/gi,
    /("password"\s*:\s*")[^"]+"/gi,
    /(token=)[^&\s]+/gi,
    /(authorization:\s*)[^\s]+/gi
  ];

  if (pack !== "strict") {
    return base;
  }

  return [
    ...base,
    /(set-cookie:\s*)[^\n]+/gi,
    /(api[-_]?key\s*[=:]\s*)[^\s,;]+/gi,
    /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi
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

export function computeQuietWindowMs(
  profile: AgentSessionOptions["stabilityProfile"],
  baseQuietWindowMs: number
): number {
  const effectiveProfile = profile ?? "balanced";
  if (effectiveProfile === "fast") {
    return Math.max(40, Math.floor(baseQuietWindowMs * 0.6));
  }
  if (effectiveProfile === "chatty") {
    return Math.max(baseQuietWindowMs, 220);
  }
  return Math.max(baseQuietWindowMs, 120);
}

export function computeNetworkIdleBudgetMs(
  profile: AgentSessionOptions["stabilityProfile"],
  actionTimeoutMs: number,
  quietWindowMs: number,
  actionType: Action["type"]
): number {
  const effectiveProfile = profile ?? "balanced";

  const base =
    actionType === "navigate" || actionType === "waitFor"
      ? Math.floor(actionTimeoutMs / 2)
      : Math.floor(actionTimeoutMs / 4);

  const floor = Math.max(quietWindowMs, 300);

  if (effectiveProfile === "fast") {
    return Math.min(1_200, Math.max(floor, Math.floor(base * 0.6)));
  }

  if (effectiveProfile === "chatty") {
    return Math.min(4_000, Math.max(floor, Math.floor(base * 1.4)));
  }

  return Math.min(2_500, Math.max(floor, base));
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

function calculateOverlapRatio(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  const overlapWidth = Math.max(0, right - left);
  const overlapHeight = Math.max(0, bottom - top);
  const overlapArea = overlapWidth * overlapHeight;

  const minArea = Math.min(a.width * a.height, b.width * b.height);
  if (minArea <= 0) {
    return 0;
  }

  return overlapArea / minArea;
}

function extractSelectorInvariant(action: Action): string | undefined {
  if (action.type === "waitFor" && action.condition.kind === "selector") {
    return action.condition.selector;
  }

  if (action.type === "assert" && action.condition.kind === "selector") {
    return action.condition.selector;
  }

  return undefined;
}

async function waitForEnterOrTimeout(timeoutMs: number): Promise<void> {
  if (!process.stdin.isTTY) {
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, timeoutMs);
    });
    return;
  }

  await new Promise<void>((resolvePromise) => {
    let done = false;
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (value.includes("\n") || value.includes("\r")) {
        cleanup();
        resolvePromise();
      }
    };

    const cleanup = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.pause();
    };

    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
