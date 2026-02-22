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
      expect(capabilities).toContain("session.pause");
      expect(capabilities).toContain("session.resume");
      expect(capabilities).toContain("session.state");

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
    let runtimeSessionId = "";

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
      const created = create.result as {
        sessionId: string;
        adapterSessionId: string;
        runtimeSessionId: string;
        runtimeTabId: string;
      };
      sessionId = created.sessionId;
      runtimeSessionId = created.runtimeSessionId;
      expect(sessionId.length).toBeGreaterThan(0);
      expect(created.adapterSessionId).toBe(sessionId);
      expect(created.runtimeSessionId.length).toBeGreaterThan(0);
      expect(created.runtimeTabId).toBe("tab_1");

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
      const navigateResult = navigate.result as {
        sessionId: string;
        adapterSessionId: string;
        runtimeSessionId: string;
      };
      expect(navigateResult.adapterSessionId).toBe(sessionId);
      expect(navigateResult.runtimeSessionId).toBe(runtimeSessionId);
      expect(navigateResult.sessionId).toBe(runtimeSessionId);

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

  it("returns explicit adapter/runtime identity fields in session state", async () => {
    const runtime = new AdapterRuntime();

    try {
      const created = await runtime.handleRequest({
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
      expect(created.ok).toBe(true);

      const createPayload = created.result as {
        sessionId: string;
        adapterSessionId: string;
        runtimeSessionId: string;
      };

      const state = await runtime.handleRequest({
        id: "state",
        method: "getSessionState",
        params: { sessionId: createPayload.sessionId }
      });
      expect(state.ok).toBe(true);

      const statePayload = state.result as {
        adapterSessionId: string;
        runtimeSessionId: string;
      };
      expect(statePayload.adapterSessionId).toBe(createPayload.adapterSessionId);
      expect(statePayload.runtimeSessionId).toBe(createPayload.runtimeSessionId);
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

  it("applies intervention retention policy in adapter session state", async () => {
    const runtime = new AdapterRuntime();

    try {
      const create = await runtime.handleRequest({
        id: "create",
        method: "createSession",
        params: {
          options: {
            headed: false,
            deterministic: true,
            captureScreenshots: false,
            maxInterventionsRetained: 1,
            interventionRetentionMode: "severity"
          }
        }
      });
      expect(create.ok).toBe(true);
      const sessionId = (create.result as { sessionId: string }).sessionId;

      await runtime.handleRequest({
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

      await runtime.handleRequest({ id: "pause-1", method: "pauseSession", params: { sessionId } });
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 60);
      });
      await runtime.handleRequest({ id: "resume-1", method: "resumeSession", params: { sessionId } });

      await runtime.handleRequest({ id: "pause-2", method: "pauseSession", params: { sessionId } });
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 60);
      });
      const resumed = await runtime.handleRequest({
        id: "resume-2",
        method: "resumeSession",
        params: { sessionId }
      });
      expect(resumed.ok).toBe(true);

      const state = await runtime.handleRequest({
        id: "state",
        method: "getSessionState",
        params: { sessionId }
      });
      expect(state.ok).toBe(true);

      const payload = state.result as {
        interventionJournal?: {
          retained?: number;
          highImpactRetained?: number;
          lowImpactRetained?: number;
          maxRetained?: number;
          mode?: string;
        };
      };
      expect(payload.interventionJournal?.retained).toBe(1);
      expect(payload.interventionJournal?.maxRetained).toBe(1);
      expect(payload.interventionJournal?.mode).toBe("severity");
      expect(payload.interventionJournal?.highImpactRetained).toBeGreaterThanOrEqual(0);
      expect(payload.interventionJournal?.lowImpactRetained).toBeGreaterThanOrEqual(0);
    } finally {
      await runtime.shutdown();
    }
  }, 120_000);

  it("accepts MCP-parity session control aliases", async () => {
    const runtime = new AdapterRuntime();

    try {
      const created = await runtime.handleRequest({
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
      expect(created.ok).toBe(true);
      const sessionId = (created.result as { sessionId: string }).sessionId;

      const paused = await runtime.handleRequest({
        id: "pause",
        method: "session.pause",
        params: { sessionId }
      });
      expect(paused.ok).toBe(true);

      const resumed = await runtime.handleRequest({
        id: "resume",
        method: "session.resume",
        params: { sessionId }
      });
      expect(resumed.ok).toBe(true);

      const state = await runtime.handleRequest({
        id: "state",
        method: "session.state",
        params: { sessionId }
      });
      expect(state.ok).toBe(true);
    } finally {
      await runtime.shutdown();
    }
  }, 120_000);

  it("shuts down idempotently when called repeatedly", async () => {
    const runtime = new AdapterRuntime();

    const created = await runtime.handleRequest({
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

    expect(created.ok).toBe(true);
    await Promise.all([runtime.shutdown(), runtime.shutdown(), runtime.shutdown()]);
  }, 120_000);
});
