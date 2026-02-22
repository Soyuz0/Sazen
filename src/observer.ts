import type { BrowserContext, Page } from "playwright";
import type { ObserverEvent, PerformanceMetrics } from "./types.js";

type Listener = (event: ObserverEvent) => void;

export class BrowserObserver {
  private readonly events: ObserverEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private seq = 1;
  private drainCursor = 0;

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly redactionPatterns: RegExp[] = [],
    private readonly noiseFilteringEnabled = true
  ) {}

  start(): void {
    this.page.on("console", (message) => {
      this.push({
        kind: "console",
        seq: this.seq++,
        timestamp: Date.now(),
        level: normalizeConsoleLevel(message.type()),
        text: this.redact(message.text()),
        location: message.location()
      });
    });

    this.page.on("pageerror", (error) => {
      this.push({
        kind: "page_error",
        seq: this.seq++,
        timestamp: Date.now(),
        message: this.redact(error.message),
        stack: this.redact(error.stack ?? "")
      });
    });

    this.context.on("request", (request) => {
      this.push({
        kind: "network",
        seq: this.seq++,
        timestamp: Date.now(),
        phase: "request",
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType()
      });
    });

    this.context.on("response", (response) => {
      this.push({
        kind: "network",
        seq: this.seq++,
        timestamp: Date.now(),
        phase: "response",
        method: response.request().method(),
        url: response.url(),
        resourceType: response.request().resourceType(),
        status: response.status(),
        statusText: response.statusText()
      });
    });

    this.context.on("requestfailed", (request) => {
      this.push({
        kind: "network",
        seq: this.seq++,
        timestamp: Date.now(),
        phase: "request_failed",
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        failureText: request.failure()?.errorText
      });
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  drain(): ObserverEvent[] {
    const chunk = this.events.slice(this.drainCursor);
    this.drainCursor = this.events.length;
    return chunk;
  }

  all(): ObserverEvent[] {
    return [...this.events];
  }

  private push(event: ObserverEvent): void {
    if (this.noiseFilteringEnabled && isLikelyNoiseEvent(event)) {
      return;
    }

    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private redact(input: string): string {
    let output = input;
    for (const pattern of this.redactionPatterns) {
      output = output.replace(pattern, "[REDACTED]");
    }
    return output;
  }
}

export function isLikelyNoiseEvent(event: ObserverEvent): boolean {
  if (event.kind === "network") {
    if (event.url.toLowerCase().includes("favicon.ico")) {
      if (event.phase === "request_failed") {
        return true;
      }
      if (event.phase === "response" && event.status === 404) {
        return true;
      }
    }

    return false;
  }

  if (event.kind === "console") {
    const text = event.text.toLowerCase();
    if (text.includes("failed to load resource") && text.includes("404")) {
      return true;
    }

    if (text.includes("input elements should have autocomplete attributes")) {
      return true;
    }

    return false;
  }

  return false;
}

function normalizeConsoleLevel(level: string): "log" | "debug" | "info" | "warn" | "error" {
  if (level === "warning") {
    return "warn";
  }

  if (level === "assert") {
    return "error";
  }

  if (level === "trace") {
    return "debug";
  }

  if (level === "log" || level === "debug" || level === "info" || level === "warn" || level === "error") {
    return level;
  }

  return "log";
}

export async function collectPerformanceMetrics(page: Page): Promise<PerformanceMetrics> {
  const result = await page.evaluate(() => {
    const navEntry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const paintEntries = performance.getEntriesByType("paint");

    const firstPaint = paintEntries.find((entry) => entry.name === "first-paint")?.startTime ?? null;
    const firstContentfulPaint =
      paintEntries.find((entry) => entry.name === "first-contentful-paint")?.startTime ?? null;

    const shifts =
      ((window as unknown as { __agentLayoutShifts?: Array<{ value: number }> }).__agentLayoutShifts ?? []).map(
        (entry) => entry.value
      );
    const layoutShiftScore = shifts.reduce((sum, value) => sum + value, 0);

    return {
      domContentLoadedMs: navEntry ? navEntry.domContentLoadedEventEnd : null,
      loadMs: navEntry ? navEntry.loadEventEnd : null,
      firstPaintMs: firstPaint,
      firstContentfulPaintMs: firstContentfulPaint,
      layoutShiftScore
    };
  });

  return result;
}

export function formatEvent(event: ObserverEvent): string {
  if (event.kind === "console") {
    return `[console.${event.level}] ${event.text}`;
  }

  if (event.kind === "page_error") {
    return `[page_error] ${event.message}`;
  }

  if (event.kind === "network") {
    if (event.phase === "request") {
      return `[network] -> ${event.method} ${event.url}`;
    }
    if (event.phase === "response") {
      return `[network] <- ${event.method} ${event.url} ${event.status ?? ""}`.trim();
    }
    return `[network] xx ${event.method} ${event.url} ${event.failureText ?? "failed"}`;
  }

  return "[event] unknown";
}
