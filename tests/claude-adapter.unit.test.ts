import { describe, expect, it } from "vitest";
import { AdapterRuntime } from "../src/adapter.js";
import {
  ClaudeCodeAdapterBridge,
  mapClaudeMethod,
  mapClaudeSlashCommand
} from "../src/claude-adapter.js";

describe("claude adapter bridge", () => {
  it("maps Claude method aliases and slash commands", () => {
    expect(mapClaudeMethod("cc.session.create")).toBe("createSession");
    expect(mapClaudeMethod("performAction")).toBe("performAction");
    expect(mapClaudeSlashCommand("/browser/session/pause")).toBe("pauseSession");
    expect(() => mapClaudeMethod("cc.unknown")).toThrowError();
    expect(() => mapClaudeSlashCommand("/browser/unknown")).toThrowError();
  });

  it("returns stable Claude response envelope for alias and slash requests", async () => {
    const runtime = new AdapterRuntime();
    const bridge = new ClaudeCodeAdapterBridge(runtime);

    try {
      const aliasResponse = await bridge.handleRequest({
        id: "ping-alias",
        method: "cc.ping"
      });
      expect(aliasResponse.ok).toBe(true);
      expect(aliasResponse.status).toBe("ok");
      expect(aliasResponse.meta.adapter).toBe("claude-code");
      expect(aliasResponse.meta.requestMethod).toBe("cc.ping");
      expect(aliasResponse.meta.mappedMethod).toBe("ping");

      const slashResponse = await bridge.handleRequest({
        id: "ping-slash",
        method: "cc.command",
        params: {
          command: "/browser/ping"
        }
      });
      expect(slashResponse.ok).toBe(true);
      expect(slashResponse.status).toBe("ok");
      expect(slashResponse.meta.requestMethod).toBe("cc.command");
      expect(slashResponse.meta.mappedMethod).toBe("ping");

      const payload = slashResponse.data as { capabilities?: string[] };
      expect(payload.capabilities ?? []).toContain("createSession");
    } finally {
      await runtime.shutdown();
    }
  });
});
