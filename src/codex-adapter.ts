import { AdapterRuntime } from "./adapter.js";
import { replayTrace } from "./replay.js";
import { SDK_CONTRACT_VERSION } from "./sdk-contract.js";
import { getTraceTimeline, loadSavedTrace } from "./trace.js";
import type { AgentSessionOptions, ReplayMode } from "./types.js";

export interface CodexServiceRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface CodexServiceResponse {
  ok: boolean;
  status: "ok" | "error";
  data?: unknown;
  error?: {
    message: string;
  };
  meta: {
    endpoint: string;
    sdkContractVersion: string;
    timestamp: string;
  };
}

export class CodexAdapterService {
  constructor(private readonly runtime: AdapterRuntime) {}

  async shutdown(): Promise<void> {
    await this.runtime.shutdown();
  }

  async handleRequest(request: CodexServiceRequest): Promise<CodexServiceResponse> {
    try {
      const result = await this.execute(request);
      return {
        ok: true,
        status: "ok",
        data: result,
        meta: this.meta(request.path)
      };
    } catch (error) {
      return {
        ok: false,
        status: "error",
        error: {
          message: error instanceof Error ? error.message : String(error)
        },
        meta: this.meta(request.path)
      };
    }
  }

  private async execute(request: CodexServiceRequest): Promise<unknown> {
    const method = request.method.toUpperCase();
    const path = request.path;

    if (method === "GET" && path === "/v1/health") {
      const ping = await this.runtime.handleRequest({ method: "ping" });
      return {
        service: "codex-adapter",
        sdkContractVersion: SDK_CONTRACT_VERSION,
        capabilities: ping.ok ? (ping.result as { capabilities?: string[] }).capabilities ?? [] : []
      };
    }

    if (method !== "POST") {
      throw new Error(`Unsupported method '${request.method}' for '${path}'`);
    }

    switch (path) {
      case "/v1/adapter": {
        const body = asObject(request.body, "Expected JSON object body");
        const adapterMethod = body.method;
        if (typeof adapterMethod !== "string" || adapterMethod.length === 0) {
          throw new Error("Missing 'method' in adapter request body");
        }
        const params =
          body.params && typeof body.params === "object" && !Array.isArray(body.params)
            ? (body.params as Record<string, unknown>)
            : undefined;
        const response = await this.runtime.handleRequest({
          id: typeof body.id === "string" || typeof body.id === "number" ? body.id : undefined,
          method: adapterMethod,
          params
        });
        if (!response.ok) {
          throw new Error(response.error?.message ?? "Adapter request failed");
        }
        return response.result;
      }
      case "/v1/session/create":
        return this.callAdapterMethod("createSession", request.body);
      case "/v1/session/close":
        return this.callAdapterMethod("closeSession", request.body);
      case "/v1/session/pause":
        return this.callAdapterMethod("pauseSession", request.body);
      case "/v1/session/resume":
        return this.callAdapterMethod("resumeSession", request.body);
      case "/v1/session/state":
        return this.callAdapterMethod("getSessionState", request.body);
      case "/v1/session/snapshot":
        return this.callAdapterMethod("snapshot", request.body);
      case "/v1/session/describe":
        return this.callAdapterMethod("describe", request.body);
      case "/v1/session/save-trace":
        return this.callAdapterMethod("saveTrace", request.body);
      case "/v1/session/save-session":
        return this.callAdapterMethod("saveSession", request.body);
      case "/v1/action":
        return this.callAdapterMethod("performAction", request.body);
      case "/v1/run":
        return this.callAdapterMethod("runActions", request.body);
      case "/v1/replay": {
        const body = asObject(request.body, "Expected JSON object body");
        const tracePath = body.tracePath;
        if (typeof tracePath !== "string" || tracePath.length === 0) {
          throw new Error("Missing 'tracePath' in replay request body");
        }

        const options =
          body.options && typeof body.options === "object" && !Array.isArray(body.options)
            ? (body.options as AgentSessionOptions)
            : {};

        const replayOptions = {
          mode: asReplayMode(body.mode),
          preflight: typeof body.preflight === "boolean" ? body.preflight : undefined,
          selectorInvariants:
            typeof body.selectorInvariants === "boolean" ? body.selectorInvariants : undefined
        };

        return replayTrace(tracePath, options, replayOptions);
      }
      case "/v1/timeline": {
        const body = asObject(request.body, "Expected JSON object body");
        const tracePath = body.tracePath;
        if (typeof tracePath !== "string" || tracePath.length === 0) {
          throw new Error("Missing 'tracePath' in timeline request body");
        }
        const { absolutePath, trace } = await loadSavedTrace(tracePath);
        const timeline = getTraceTimeline(trace);
        const limit =
          typeof body.limit === "number" && Number.isFinite(body.limit)
            ? Math.max(1, Math.floor(body.limit))
            : timeline.length;
        return {
          tracePath: absolutePath,
          total: timeline.length,
          entries: timeline.slice(0, limit)
        };
      }
      default:
        throw new Error(`Unsupported endpoint '${path}'`);
    }
  }

  private async callAdapterMethod(method: string, body: unknown): Promise<unknown> {
    const params =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const response = await this.runtime.handleRequest({ method, params });
    if (!response.ok) {
      throw new Error(response.error?.message ?? `Adapter method '${method}' failed`);
    }
    return response.result;
  }

  private meta(endpoint: string): CodexServiceResponse["meta"] {
    return {
      endpoint,
      sdkContractVersion: SDK_CONTRACT_VERSION,
      timestamp: new Date().toISOString()
    };
  }
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function asReplayMode(value: unknown): ReplayMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "strict" || value === "relaxed") {
    return value;
  }
  throw new Error("Invalid replay mode; expected 'strict' or 'relaxed'");
}
