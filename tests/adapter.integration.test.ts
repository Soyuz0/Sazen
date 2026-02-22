import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdapterRuntime } from "../src/adapter.js";
import { startFixtureServer, type RunningFixtureServer } from "./helpers/fixtureServer.js";

describe("adapter runtime", () => {
  let fixture: RunningFixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("handles ping and unknown methods", async () => {
    const runtime = new AdapterRuntime();
    try {
      const ping = await runtime.handleRequest({ id: 1, method: "ping" });
      expect(ping.ok).toBe(true);
      const capabilities = (ping.result as { capabilities?: string[] }).capabilities ?? [];
      expect(capabilities).toContain("pauseSession");
      expect(capabilities).toContain("resumeSession");

      const unknown = await runtime.handleRequest({ id: 2, method: "nope" });
      expect(unknown.ok).toBe(false);
      expect(unknown.error?.message).toMatch(/unsupported/i);
    } finally {
      await runtime.shutdown();
    }
  });

  it("creates a session and performs actions", async () => {
    const runtime = new AdapterRuntime();
    let sessionId = "";

    try {
      const create = await runtime.handleRequest({
        id: "create",
        method: "createSession",
        params: {
          options: {
            headed: false,
            deterministic: true,
            captureScreenshots: false
          }
        }
      });

      expect(create.ok).toBe(true);
      sessionId = (create.result as { sessionId: string }).sessionId;
      expect(sessionId.length).toBeGreaterThan(0);

      const navigate = await runtime.handleRequest({
        id: "nav",
        method: "performAction",
        params: {
          sessionId,
          action: {
            type: "navigate",
            url: fixture.baseUrl
          }
        }
      });
      expect(navigate.ok).toBe(true);

      const describe = await runtime.handleRequest({
        id: "describe",
        method: "describe",
        params: {
          sessionId,
          maxElements: 10
        }
      });
      expect(describe.ok).toBe(true);

      const close = await runtime.handleRequest({
        id: "close",
        method: "closeSession",
        params: { sessionId }
      });
      expect(close.ok).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  }, 120_000);

  it("supports pausing and resuming runActions", async () => {
    const runtime = new AdapterRuntime();

    try {
      const create = await runtime.handleRequest({
        id: "create",
        method: "createSession",
        params: {
          options: {
            headed: false,
            deterministic: true,
            captureScreenshots: false
          }
        }
      });
      expect(create.ok).toBe(true);
      const sessionId = (create.result as { sessionId: string }).sessionId;

      const paused = await runtime.handleRequest({
        id: "pause",
        method: "pauseSession",
        params: { sessionId }
      });
      expect(paused.ok).toBe(true);

      let completed = false;
      const runPromise = runtime
        .handleRequest({
          id: "run",
          method: "runActions",
          params: {
            sessionId,
            actions: [
              {
                type: "navigate",
                url: fixture.baseUrl
              },
              {
                type: "snapshot"
              }
            ]
          }
        })
        .then((response) => {
          completed = true;
          return response;
        });

      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 150);
      });
      expect(completed).toBe(false);

      const stateWhilePaused = await runtime.handleRequest({
        id: "state",
        method: "getSessionState",
        params: { sessionId }
      });
      expect(stateWhilePaused.ok).toBe(true);
      const pausedState = stateWhilePaused.result as {
        paused: boolean;
        runActive: boolean;
      };
      expect(pausedState.paused).toBe(true);
      expect(pausedState.runActive).toBe(true);

      const resumed = await runtime.handleRequest({
        id: "resume",
        method: "resumeSession",
        params: { sessionId }
      });
      expect(resumed.ok).toBe(true);

      const runResult = await runPromise;
      expect(runResult.ok).toBe(true);
      const payload = runResult.result as {
        count: number;
        pausedMs: number;
      };
      expect(payload.count).toBe(2);
      expect(payload.pausedMs).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown();
    }
  }, 120_000);
});
