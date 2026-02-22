import { randomUUID } from "node:crypto";
import { AgentSession } from "./session.js";
import { createAgentPageDescription } from "./snapshot.js";
import type { Action, AgentSessionOptions } from "./types.js";

export interface AdapterRequest {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface AdapterResponse {
  id?: string | number;
  ok: boolean;
  result?: unknown;
  error?: {
    message: string;
  };
}

interface SessionEntry {
  id: string;
  session: AgentSession;
  control: {
    runActive: boolean;
    runId?: string;
  };
}

export class AdapterRuntime {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly operationLocks = new Map<string, Promise<void>>();

  async handleRequest(request: AdapterRequest): Promise<AdapterResponse> {
    try {
      const result = await this.execute(request.method, request.params ?? {});
      return {
        id: request.id,
        ok: true,
        result
      };
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  async shutdown(): Promise<void> {
    for (const entry of this.sessions.values()) {
      await entry.session.close().catch(() => undefined);
    }
    this.sessions.clear();
  }

  private async execute(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "ping":
        return {
          version: "0.1.0",
          capabilities: [
            "createSession",
            "performAction",
            "runActions",
            "pauseSession",
            "resumeSession",
            "getSessionState",
            "session.pause",
            "session.resume",
            "session.state",
            "snapshot",
            "describe",
            "saveTrace",
            "saveSession",
            "closeSession",
            "shutdown"
          ]
        };

      case "createSession":
        return this.createSession(params);

      case "closeSession":
        return this.closeSession(params);

      case "performAction":
        return this.performAction(params);

      case "runActions":
        return this.runActions(params);

      case "pauseSession":
      case "session.pause":
        return this.pauseSession(params);

      case "resumeSession":
      case "session.resume":
        return this.resumeSession(params);

      case "getSessionState":
      case "session.state":
        return this.getSessionState(params);

      case "snapshot":
        return this.snapshot(params);

      case "describe":
        return this.describe(params);

      case "saveTrace":
        return this.saveTrace(params);

      case "saveSession":
        return this.saveSession(params);

      case "shutdown":
        await this.shutdown();
        return { ok: true };

      default:
        throw new Error(`Unsupported adapter method '${method}'`);
    }
  }

  private async createSession(params: Record<string, unknown>): Promise<{ sessionId: string }> {
    const options = (params.options as AgentSessionOptions | undefined) ?? {};
    const session = new AgentSession(options);
    await session.start();
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      session,
      control: {
        runActive: false
      }
    });
    return { sessionId };
  }

  private async closeSession(params: Record<string, unknown>): Promise<{ closed: boolean }> {
    const sessionId = this.requireSessionId(params.sessionId);
    return this.enqueueSessionOperation(sessionId, async () => {
      const session = this.requireSession(sessionId);
      await session.close();
      this.sessions.delete(sessionId);
      this.operationLocks.delete(sessionId);
      return { closed: true };
    });
  }

  private async performAction(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = this.requireSessionId(params.sessionId);
    const entry = this.requireSessionEntry(sessionId);
    const action = params.action as Action | undefined;
    if (!action) {
      throw new Error("Missing 'action' in performAction params");
    }
    return this.enqueueSessionOperation(sessionId, async () => {
      return entry.session.perform(action);
    });
  }

  private async runActions(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = this.requireSessionId(params.sessionId);
    const entry = this.requireSessionEntry(sessionId);
    const actions = params.actions as Action[] | undefined;
    if (!actions || !Array.isArray(actions)) {
      throw new Error("Missing 'actions' array in runActions params");
    }

    const runId =
      typeof params.runId === "string" && params.runId.length > 0 ? params.runId : randomUUID();

    return this.enqueueSessionOperation(sessionId, async () => {
      entry.control.runActive = true;
      entry.control.runId = runId;
      const pauseBaseline = entry.session.getExecutionControlState().pausedMs;

      try {
        const results = [];
        for (const action of actions) {
          results.push(await entry.session.perform(action));
        }

        return {
          runId,
          count: results.length,
          pausedMs: Math.max(0, entry.session.getExecutionControlState().pausedMs - pauseBaseline),
          results
        };
      } finally {
        entry.control.runActive = false;
        entry.control.runId = undefined;
      }
    });
  }

  private async pauseSession(params: Record<string, unknown>): Promise<unknown> {
    const entry = this.requireSessionEntry(params.sessionId);
    const state = entry.session.pauseExecution("adapter");

    return {
      paused: state.paused,
      pausedMs: state.pausedMs,
      sources: state.sources,
      runActive: entry.control.runActive,
      runId: entry.control.runId,
      latestIntervention: entry.session.getLatestIntervention()
    };
  }

  private async resumeSession(params: Record<string, unknown>): Promise<unknown> {
    const entry = this.requireSessionEntry(params.sessionId);
    const state = await entry.session.resumeExecution("adapter");

    return {
      paused: state.paused,
      pausedMs: state.pausedMs,
      sources: state.sources,
      runActive: entry.control.runActive,
      runId: entry.control.runId,
      latestIntervention: entry.session.getLatestIntervention()
    };
  }

  private async getSessionState(params: Record<string, unknown>): Promise<unknown> {
    const entry = this.requireSessionEntry(params.sessionId);
    const state = entry.session.getExecutionControlState();
    return {
      paused: state.paused,
      runActive: entry.control.runActive,
      runId: entry.control.runId,
      pausedMs: state.pausedMs,
      sources: state.sources,
      latestIntervention: entry.session.getLatestIntervention()
    };
  }

  private async snapshot(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = this.requireSessionId(params.sessionId);
    const entry = this.requireSessionEntry(sessionId);
    return this.enqueueSessionOperation(sessionId, async () => {
      return entry.session.snapshot();
    });
  }

  private async describe(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = this.requireSessionId(params.sessionId);
    const entry = this.requireSessionEntry(sessionId);
    const maxElements = Number(params.maxElements ?? 80);
    return this.enqueueSessionOperation(sessionId, async () => {
      const snapshot = await entry.session.snapshot();
      return createAgentPageDescription(snapshot, {
        maxElements: Number.isFinite(maxElements) ? maxElements : 80
      });
    });
  }

  private async saveTrace(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = this.requireSessionId(params.sessionId);
    const entry = this.requireSessionEntry(sessionId);
    const filePath = params.filePath;
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new Error("Missing 'filePath' in saveTrace params");
    }
    return this.enqueueSessionOperation(sessionId, async () => ({
      path: await entry.session.saveTrace(filePath)
    }));
  }

  private async saveSession(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = this.requireSessionId(params.sessionId);
    const entry = this.requireSessionEntry(sessionId);
    const name = params.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("Missing 'name' in saveSession params");
    }
    const rootDir = typeof params.rootDir === "string" ? params.rootDir : undefined;
    return this.enqueueSessionOperation(sessionId, async () => ({
      path: await entry.session.saveSession(name, rootDir)
    }));
  }

  private enqueueSessionOperation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const queued = previous.catch(() => undefined).then(() => next);
    this.operationLocks.set(sessionId, queued);

    return previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        release();
        if (this.operationLocks.get(sessionId) === queued) {
          this.operationLocks.delete(sessionId);
        }
      });
  }

  private requireSessionId(rawSessionId: unknown): string {
    if (typeof rawSessionId !== "string" || rawSessionId.length === 0) {
      throw new Error("Missing or invalid 'sessionId'");
    }
    return rawSessionId;
  }

  private requireSessionEntry(rawSessionId: unknown): SessionEntry {
    const sessionId = this.requireSessionId(rawSessionId);
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new Error(`Unknown session '${sessionId}'`);
    }
    return entry;
  }

  private requireSession(rawSessionId: unknown): AgentSession {
    return this.requireSessionEntry(rawSessionId).session;
  }
}
