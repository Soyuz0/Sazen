import { AdapterRuntime, type AdapterRequest, type AdapterResponse } from "./adapter.js";

const OPENCODE_METHOD_MAP: Record<string, string> = {
  "oc.ping": "ping",
  "oc.session.create": "createSession",
  "oc.session.close": "closeSession",
  "oc.session.action": "performAction",
  "oc.session.run": "runActions",
  "oc.session.pause": "pauseSession",
  "oc.session.resume": "resumeSession",
  "oc.session.state": "getSessionState",
  "oc.session.snapshot": "snapshot",
  "oc.session.describe": "describe",
  "oc.session.saveTrace": "saveTrace",
  "oc.session.saveSession": "saveSession",
  "oc.shutdown": "shutdown"
};

export function mapOpenCodeMethod(method: string): string {
  if (method in OPENCODE_METHOD_MAP) {
    return OPENCODE_METHOD_MAP[method] as string;
  }
  if (method.startsWith("oc.")) {
    throw new Error(`Unsupported OpenCode adapter method '${method}'`);
  }
  return method;
}

export class OpenCodeAdapterBridge {
  constructor(private readonly runtime: AdapterRuntime) {}

  async handleRequest(request: AdapterRequest): Promise<AdapterResponse> {
    const mappedMethod = mapOpenCodeMethod(request.method);
    return this.runtime.handleRequest({
      ...request,
      method: mappedMethod
    });
  }
}
