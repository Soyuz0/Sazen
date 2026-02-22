import { describe, expect, it } from "vitest";
import { AdapterRuntime } from "../src/adapter.js";
import { mapOpenCodeMethod, OpenCodeAdapterBridge } from "../src/opencode-adapter.js";

describe("opencode adapter bridge", () => {
  it("maps OpenCode method aliases to base adapter methods", () => {
    expect(mapOpenCodeMethod("oc.session.create")).toBe("createSession");
    expect(mapOpenCodeMethod("performAction")).toBe("performAction");
    expect(() => mapOpenCodeMethod("oc.unknown")).toThrowError();
  });

  it("routes bridged ping requests through adapter runtime", async () => {
    const runtime = new AdapterRuntime();
    const bridge = new OpenCodeAdapterBridge(runtime);

    try {
      const response = await bridge.handleRequest({
        id: "ping",
        method: "oc.ping"
      });

      expect(response.ok).toBe(true);
      const capabilities = (response.result as { capabilities?: string[] }).capabilities ?? [];
      expect(capabilities).toContain("createSession");
    } finally {
      await runtime.shutdown();
    }
  });
});
