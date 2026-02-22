import { type AdapterRequest, type AdapterResponse, AdapterRuntime } from "./adapter.js";
import { SDK_CONTRACT_VERSION } from "./sdk-contract.js";

const CLAUDE_METHOD_MAP: Record<string, string> = {
  "cc.ping": "ping",
  "cc.session.create": "createSession",
  "cc.session.close": "closeSession",
  "cc.session.action": "performAction",
  "cc.session.run": "runActions",
  "cc.session.pause": "pauseSession",
  "cc.session.resume": "resumeSession",
  "cc.session.state": "getSessionState",
  "cc.session.snapshot": "snapshot",
  "cc.session.describe": "describe",
  "cc.session.saveTrace": "saveTrace",
  "cc.session.saveSession": "saveSession",
  "cc.shutdown": "shutdown"
};

const CLAUDE_SLASH_MAP: Record<string, string> = {
  "/browser/ping": "ping",
  "/browser/session/create": "createSession",
  "/browser/session/close": "closeSession",
  "/browser/session/action": "performAction",
  "/browser/session/run": "runActions",
  "/browser/session/pause": "pauseSession",
  "/browser/session/resume": "resumeSession",
  "/browser/session/state": "getSessionState",
  "/browser/session/snapshot": "snapshot",
  "/browser/session/describe": "describe",
  "/browser/session/save-trace": "saveTrace",
  "/browser/session/save-session": "saveSession",
  "/browser/shutdown": "shutdown"
};

export interface ClaudeAdapterResponse {
  id?: string | number;
  ok: boolean;
  status: "ok" | "error";
  data?: unknown;
  error?: {
    message: string;
  };
  meta: {
    adapter: "claude-code";
    requestMethod: string;
    mappedMethod: string;
    sdkContractVersion: string;
  };
}

export function mapClaudeMethod(method: string): string {
  if (method in CLAUDE_METHOD_MAP) {
    return CLAUDE_METHOD_MAP[method] as string;
  }
  if (method.startsWith("cc.")) {
    throw new Error(`Unsupported Claude adapter method '${method}'`);
  }
  return method;
}

export function mapClaudeSlashCommand(command: string): string {
  if (command in CLAUDE_SLASH_MAP) {
    return CLAUDE_SLASH_MAP[command] as string;
  }
  throw new Error(`Unsupported Claude slash command '${command}'`);
}

function normalizeClaudeRequest(request: AdapterRequest): {
  mappedMethod: string;
  normalized: AdapterRequest;
} {
  if (request.method === "cc.command" || request.method === "claude.command") {
    const command = request.params?.command;
    if (typeof command !== "string" || command.length === 0) {
      throw new Error("Missing 'command' in Claude slash request params");
    }
    const mappedMethod = mapClaudeSlashCommand(command);
    const args = request.params?.args;
    const params =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : undefined;
    return {
      mappedMethod,
      normalized: {
        id: request.id,
        method: mappedMethod,
        params
      }
    };
  }

  if (request.method.startsWith("/")) {
    const mappedMethod = mapClaudeSlashCommand(request.method);
    return {
      mappedMethod,
      normalized: {
        ...request,
        method: mappedMethod
      }
    };
  }

  const mappedMethod = mapClaudeMethod(request.method);
  return {
    mappedMethod,
    normalized: {
      ...request,
      method: mappedMethod
    }
  };
}

export class ClaudeCodeAdapterBridge {
  constructor(private readonly runtime: AdapterRuntime) {}

  async handleRequest(request: AdapterRequest): Promise<ClaudeAdapterResponse> {
    const requestMethod = request.method;

    try {
      const { mappedMethod, normalized } = normalizeClaudeRequest(request);
      const response = await this.runtime.handleRequest(normalized);
      return this.toClaudeResponse(response, requestMethod, mappedMethod);
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        status: "error",
        error: {
          message: error instanceof Error ? error.message : String(error)
        },
        meta: {
          adapter: "claude-code",
          requestMethod,
          mappedMethod: requestMethod,
          sdkContractVersion: SDK_CONTRACT_VERSION
        }
      };
    }
  }

  private toClaudeResponse(
    response: AdapterResponse,
    requestMethod: string,
    mappedMethod: string
  ): ClaudeAdapterResponse {
    return {
      id: response.id,
      ok: response.ok,
      status: response.ok ? "ok" : "error",
      data: response.result,
      error: response.error,
      meta: {
        adapter: "claude-code",
        requestMethod,
        mappedMethod,
        sdkContractVersion: SDK_CONTRACT_VERSION
      }
    };
  }
}
