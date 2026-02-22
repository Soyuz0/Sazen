import { describe, expect, it } from "vitest";
import { AdapterRuntime } from "../src/adapter.js";
import { CodexAdapterService } from "../src/codex-adapter.js";

describe("codex adapter service", () => {
  it("returns health payload with deterministic envelope", async () => {
    const runtime = new AdapterRuntime();
    const service = new CodexAdapterService(runtime);

    try {
      const response = await service.handleRequest({ method: "GET", path: "/v1/health" });
      expect(response.ok).toBe(true);
      expect(response.status).toBe("ok");
      const payload = response.data as { service?: string; capabilities?: string[] };
      expect(payload.service).toBe("codex-adapter");
      expect(payload.capabilities ?? []).toContain("createSession");
    } finally {
      await service.shutdown();
    }
  });

  it("proxies generic adapter requests via /v1/adapter", async () => {
    const runtime = new AdapterRuntime();
    const service = new CodexAdapterService(runtime);

    try {
      const response = await service.handleRequest({
        method: "POST",
        path: "/v1/adapter",
        body: {
          method: "ping"
        }
      });
      expect(response.ok).toBe(true);
      const payload = response.data as { capabilities?: string[] };
      expect(payload.capabilities ?? []).toContain("runActions");
    } finally {
      await service.shutdown();
    }
  });

  it("reports stable errors for invalid timeline requests", async () => {
    const runtime = new AdapterRuntime();
    const service = new CodexAdapterService(runtime);

    try {
      const response = await service.handleRequest({
        method: "POST",
        path: "/v1/timeline",
        body: {}
      });
      expect(response.ok).toBe(false);
      expect(response.status).toBe("error");
      expect(response.error?.message).toContain("tracePath");
    } finally {
      await service.shutdown();
    }
  });
});
