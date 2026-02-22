import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replayTrace } from "../src/replay.js";
import { AgentSession } from "../src/session.js";
import { startFixtureServer, type RunningFixtureServer } from "./helpers/fixtureServer.js";

describe("agent session integration", () => {
  let fixture: RunningFixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it(
    "runs a real flow, emits events, saves trace, and replays deterministically",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-flow-"));
      const tracePath = join(tempDir, "trace.json");

      const session = new AgentSession({
        headed: false,
        deterministic: true,
        captureScreenshots: false,
        artifactsDir: tempDir
      });

      const actionResults: Array<{ status: string; events: string[] }> = [];

      try {
        await session.start();

        const navigate = await session.perform({
          type: "navigate",
          url: fixture.baseUrl
        });
        expect(navigate.status).toBe("ok");

        const fillEmail = await session.perform({
          type: "fill",
          target: { kind: "css", selector: "[data-testid='email-input']" },
          value: "agent@example.com"
        });
        expect(fillEmail.status).toBe("ok");

        const fillPassword = await session.perform({
          type: "fill",
          target: { kind: "css", selector: "[data-testid='password-input']" },
          value: "supersecret"
        });
        expect(fillPassword.status).toBe("ok");

        const clickSubmit = await session.perform({
          type: "click",
          target: { kind: "css", selector: "[data-testid='submit-button']" }
        });

        const waitForResult = await session.perform({
          type: "waitFor",
          condition: {
            kind: "selector",
            selector: "#result",
            state: "visible"
          }
        });

        const snapshot = await session.perform({ type: "snapshot" });
        expect(clickSubmit.status).toBe("ok");
        expect(waitForResult.status).toBe("ok");
        expect(snapshot.status).toBe("ok");

        const resultNode = snapshot.postSnapshot.nodes.find((node) => node.attributes.id === "result");
        expect(resultNode?.text).toContain("Welcome agent@example.com");

        actionResults.push(
          ...[navigate, fillEmail, fillPassword, clickSubmit, waitForResult, snapshot].map((result) => ({
            status: result.status,
            events: result.events.map((event) =>
              event.kind === "console" ? event.text : event.kind === "network" ? event.url : event.message
            )
          }))
        );

        const savedPath = await session.saveTrace(tracePath);
        expect(savedPath).toBe(tracePath);
      } finally {
        await session.close();
      }

      const allEvents = actionResults.flatMap((result) => result.events).join("\n");
      expect(allEvents).toContain("[fixture] login success");
      expect(allEvents).toContain(fixture.baseUrl);

      const replay = await replayTrace(tracePath, {
        headed: false,
        deterministic: true,
        captureScreenshots: false,
        artifactsDir: tempDir
      });

      expect(replay.totalActions).toBe(6);
      expect(replay.mismatched).toBe(0);

      await rm(tempDir, { recursive: true, force: true });
    },
    120_000
  );

  it("saves and reloads a session manifest", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-session-"));
    const rootDir = join(tempDir, "sessions");
    const sessionName = "saved";

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false,
      artifactsDir: tempDir
    });

    try {
      await session.start();
      const nav = await session.perform({ type: "navigate", url: fixture.baseUrl });
      expect(nav.status).toBe("ok");

      const manifestPath = await session.saveSession(sessionName, rootDir);
      expect(manifestPath).toContain("session.json");
    } finally {
      await session.close();
    }

    const loaded = await AgentSession.loadSavedSession(
      sessionName,
      {
        headed: false,
        deterministic: true,
        captureScreenshots: false,
        artifactsDir: tempDir
      },
      rootDir
    );

    try {
      const snapshot = await loaded.snapshot();
      expect(snapshot.url).toContain(fixture.baseUrl);
    } finally {
      await loaded.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("handles ambiguous role targets by selecting actionable candidates", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-ambiguous-"));

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false,
      artifactsDir: tempDir
    });

    try {
      await session.start();

      const navigate = await session.perform({
        type: "navigate",
        url: `${fixture.baseUrl}/ambiguous.html`
      });
      expect(navigate.status).toBe("ok");

      const click = await session.perform({
        type: "click",
        target: {
          kind: "roleName",
          role: "button",
          name: "Search"
        }
      });

      expect(click.status).toBe("ok");

      const snapshot = await session.perform({ type: "snapshot" });
      const statusNode = snapshot.postSnapshot.nodes.find((node) => node.attributes.id === "status");
      expect(statusNode?.text).toContain("clicked-visible-search");

      const eventText = click.events
        .map((event) => (event.kind === "console" ? event.text : ""))
        .join("\n");
      expect(eventText).toContain("[fixture] visible search clicked");
    } finally {
      await session.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("supports setting viewport resolution during a run", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-viewport-"));

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false,
      artifactsDir: tempDir,
      viewportWidth: 1366,
      viewportHeight: 768
    });

    try {
      await session.start();
      const nav = await session.perform({ type: "navigate", url: fixture.baseUrl });
      expect(nav.status).toBe("ok");
      expect(nav.postSnapshot.viewport.width).toBe(1366);
      expect(nav.postSnapshot.viewport.height).toBe(768);

      const resized = await session.perform({
        type: "setViewport",
        width: 1024,
        height: 600
      });

      expect(resized.status).toBe("ok");
      expect(resized.postSnapshot.viewport.width).toBe(1024);
      expect(resized.postSnapshot.viewport.height).toBe(600);
    } finally {
      await session.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);
});
