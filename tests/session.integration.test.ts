import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replayTrace } from "../src/replay.js";
import { AgentSession } from "../src/session.js";
import type { SavedTrace } from "../src/types.js";
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

        const assertButtonSize = await session.perform({
          type: "assert",
          condition: {
            kind: "selector_bbox_min",
            selector: "[data-testid='submit-button']",
            minWidth: 40,
            minHeight: 24
          }
        });
        expect(assertButtonSize.status).toBe("ok");

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

        const assertNoOverlap = await session.perform({
          type: "assert",
          condition: {
            kind: "selector_overlap_max",
            selectorA: "[data-testid='submit-button']",
            selectorB: "#result",
            maxOverlapRatio: 0
          }
        });
        expect(assertNoOverlap.status).toBe("ok");

        const resultNode = snapshot.postSnapshot.nodes.find((node) => node.attributes.id === "result");
        expect(resultNode?.text).toContain("Welcome agent@example.com");

        actionResults.push(
          ...[
            navigate,
            fillEmail,
            assertButtonSize,
            fillPassword,
            clickSubmit,
            waitForResult,
            snapshot,
            assertNoOverlap
          ].map((result) => ({
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

      expect(replay.totalActions).toBe(8);
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

  it("switches profiles within a single trace using switchProfile action", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-switch-profile-"));
    const profilesRoot = join(tempDir, "profiles");
    const profileUrl = `${fixture.baseUrl}/profile-switch.html`;

    const saveProfile = async (name: string, selector: string) => {
      const profileSession = new AgentSession({
        headed: false,
        deterministic: true,
        captureScreenshots: false,
        artifactsDir: tempDir
      });

      try {
        await profileSession.start();
        const nav = await profileSession.perform({ type: "navigate", url: profileUrl });
        expect(nav.status).toBe("ok");

        const click = await profileSession.perform({
          type: "click",
          target: {
            kind: "css",
            selector
          }
        });
        expect(click.status).toBe("ok");

        const manifestPath = await profileSession.saveSession(name, profilesRoot);
        expect(manifestPath).toContain("session.json");
      } finally {
        await profileSession.close();
      }
    };

    await saveProfile("admin", "#set-admin");
    await saveProfile("user", "#set-user");

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false,
      artifactsDir: tempDir
    });

    try {
      await session.start();

      const adminSwitch = await session.perform({
        type: "switchProfile",
        profile: "admin",
        profilesRoot
      });
      expect(adminSwitch.status).toBe("ok");
      expect(adminSwitch.postSnapshot.url).toContain("profile-switch.html");

      const adminAssert = await session.perform({
        type: "assert",
        condition: {
          kind: "selector",
          selector: "#current-profile",
          textContains: "admin"
        }
      });
      expect(adminAssert.status).toBe("ok");

      const userSwitch = await session.perform({
        type: "switchProfile",
        profile: "user",
        profilesRoot
      });
      expect(userSwitch.status).toBe("ok");

      const userAssert = await session.perform({
        type: "assert",
        condition: {
          kind: "selector",
          selector: "#current-profile",
          textContains: "user"
        }
      });
      expect(userAssert.status).toBe("ok");
    } finally {
      await session.close();
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

  it("handles consent banners and supports assert actions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-consent-"));

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false,
      artifactsDir: tempDir
    });

    try {
      await session.start();
      const nav = await session.perform({ type: "navigate", url: `${fixture.baseUrl}/consent.html` });
      expect(nav.status).toBe("ok");

      const consent = await session.perform({
        type: "handleConsent",
        mode: "accept",
        requireFound: true
      });
      expect(consent.status).toBe("ok");

      const assertStatus = await session.perform({
        type: "assert",
        condition: {
          kind: "selector",
          selector: "#consent-status",
          state: "visible",
          textContains: "accepted"
        }
      });

      expect(assertStatus.status).toBe("ok");

      const assertUrl = await session.perform({
        type: "assert",
        condition: {
          kind: "url_contains",
          value: "/consent.html"
        }
      });
      expect(assertUrl.status).toBe("ok");
    } finally {
      await session.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("applies region-aware consent strategy hooks", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-consent-region-"));

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false,
      artifactsDir: tempDir
    });

    try {
      await session.start();
      const nav = await session.perform({ type: "navigate", url: `${fixture.baseUrl}/consent-region.html` });
      expect(nav.status).toBe("ok");

      const consent = await session.perform({
        type: "handleConsent",
        mode: "reject",
        strategy: "auto",
        region: "eu",
        requireFound: true
      });
      expect(consent.status).toBe("ok");

      const assertStatus = await session.perform({
        type: "assert",
        condition: {
          kind: "selector",
          selector: "#state",
          state: "visible",
          textContains: "rejected"
        }
      });

      expect(assertStatus.status).toBe("ok");
    } finally {
      await session.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("writes context attachment manifest for screenshot-producing actions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-context-attach-"));
    const contextDir = join(tempDir, "context");

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: true,
      artifactsDir: tempDir,
      contextAttachmentsDir: contextDir
    });

    try {
      await session.start();
      const nav = await session.perform({ type: "navigate", url: fixture.baseUrl });
      expect(nav.status).toBe("ok");

      const manifestRaw = await readFile(join(contextDir, "latest.json"), "utf8");
      const manifest = JSON.parse(manifestRaw) as {
        actionType: string;
        latestPath: string;
      };
      expect(manifest.actionType).toBe("navigate");
      expect(manifest.latestPath.endsWith("latest.png") || manifest.latestPath.endsWith("latest.bin")).toBe(true);

      const streamRaw = await readFile(join(contextDir, "attachments.jsonl"), "utf8");
      expect(streamRaw.trim().length).toBeGreaterThan(0);
    } finally {
      await session.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("supports visual baseline asserts within assert actions", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-visual-assert-"));

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      browserOverlay: false,
      captureScreenshots: true,
      artifactsDir: tempDir
    });

    try {
      await session.start();
      const nav = await session.perform({ type: "navigate", url: fixture.baseUrl });
      expect(nav.status).toBe("ok");
      expect(typeof nav.screenshotPath).toBe("string");

      const baselinePath = nav.screenshotPath as string;
      const passing = await session.perform({
        type: "assert",
        condition: {
          kind: "visual_baseline",
          baselinePath,
          maxMismatchRatio: 0
        }
      });
      expect(passing.status).toBe("ok");

      const fill = await session.perform({
        type: "fill",
        target: {
          kind: "css",
          selector: "[data-testid='email-input']"
        },
        value: "changed@example.com"
      });
      expect(fill.status).toBe("ok");

      const failing = await session.perform({
        type: "assert",
        condition: {
          kind: "visual_baseline",
          baselinePath,
          maxMismatchRatio: 0
        }
      });
      expect(failing.status).toBe("fatal_error");
      expect(failing.error?.message).toContain("Visual baseline assert failed");
    } finally {
      await session.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("supports pause action and captures intervention summary", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-pause-"));

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false,
      artifactsDir: tempDir
    });

    try {
      await session.start();
      await session.perform({ type: "navigate", url: fixture.baseUrl });

      const paused = await session.perform({
        type: "pause",
        mode: "timeout",
        timeoutMs: 200,
        note: "manual review"
      });

      expect(paused.status).toBe("ok");
      expect(paused.pauseSummary?.mode).toBe("timeout");
      expect((paused.pauseSummary?.elapsedMs ?? 0) >= 180).toBe(true);
      expect(paused.pauseSummary?.urlChanged).toBe(false);
    } finally {
      await session.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("records run-level pause interventions and provenance markers in traces", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-intervention-"));
    const tracePath = join(tempDir, "trace.json");

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false,
      artifactsDir: tempDir
    });

    try {
      await session.start();
      await session.perform({ type: "navigate", url: fixture.baseUrl });

      const paused = session.pauseExecution("test");
      expect(paused.paused).toBe(true);

      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 100);
      });

      const resumed = await session.resumeExecution("test");
      expect(resumed.paused).toBe(false);

      const snapshot = await session.perform({ type: "snapshot" });
      expect(snapshot.status).toBe("ok");

      await session.saveTrace(tracePath);
      const raw = await readFile(tracePath, "utf8");
      const trace = JSON.parse(raw) as SavedTrace;

      expect((trace.interventions ?? []).length).toBe(1);
      const intervention = (trace.interventions ?? [])[0];
      expect(intervention.elapsedMs).toBeGreaterThanOrEqual(80);
      expect(intervention.sources).toContain("test");
      expect(intervention.storageDelta).toBeDefined();
      expect(Array.isArray(intervention.reconciliationHints)).toBe(true);

      const actions = trace.timeline?.map((entry) => entry.actionType) ?? [];
      expect(actions).toContain("pause_start");
      expect(actions).toContain("pause_resume");
    } finally {
      await session.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("enforces max retained intervention journal entries when configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-intervention-retention-"));
    const tracePath = join(tempDir, "trace.json");

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false,
      artifactsDir: tempDir,
      maxInterventionsRetained: 1
    });

    try {
      await session.start();
      await session.perform({ type: "navigate", url: fixture.baseUrl });

      session.pauseExecution("first");
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 60);
      });
      await session.resumeExecution("first");

      session.pauseExecution("second");
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 60);
      });
      await session.resumeExecution("second");

      const journalState = session.getInterventionJournalState();
      expect(journalState.retained).toBe(1);
      expect(journalState.maxRetained).toBe(1);
      expect(session.getLatestIntervention()?.sources).toContain("second");

      await session.saveTrace(tracePath);
      const raw = await readFile(tracePath, "utf8");
      const trace = JSON.parse(raw) as SavedTrace;
      expect((trace.interventions ?? []).length).toBe(1);
      expect((trace.interventions ?? [])[0].sources).toContain("second");
    } finally {
      await session.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("prefers retaining high-impact interventions in severity retention mode", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-browser-intervention-severity-"));
    const tracePath = join(tempDir, "trace.json");

    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false,
      artifactsDir: tempDir,
      maxInterventionsRetained: 1,
      interventionRetentionMode: "severity"
    });

    try {
      await session.start();
      await session.perform({ type: "navigate", url: fixture.baseUrl });

      session.pauseExecution("high-impact");
      const internalPage = (session as unknown as { page?: { evaluate: (cb: () => void) => Promise<void> } }).page;
      expect(internalPage).toBeDefined();
      await internalPage?.evaluate(() => {
        window.location.hash = `severity-${Date.now()}`;
      });
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 60);
      });
      await session.resumeExecution("high-impact");

      session.pauseExecution("low-impact");
      await new Promise((resolvePromise) => {
        setTimeout(resolvePromise, 60);
      });
      await session.resumeExecution("low-impact");

      const journalState = session.getInterventionJournalState();
      expect(journalState.retained).toBe(1);
      expect(journalState.mode).toBe("severity");
      expect(journalState.highImpactRetained).toBe(1);
      expect(journalState.lowImpactRetained).toBe(0);
      expect(journalState.trimmed).toBe(1);
      expect(journalState.trimmedLowImpact).toBe(1);

      const latest = session.getLatestIntervention();
      expect(latest?.severity).toBe("high");
      expect(latest?.sources).toContain("high-impact");

      await session.saveTrace(tracePath);
      const raw = await readFile(tracePath, "utf8");
      const trace = JSON.parse(raw) as SavedTrace;
      expect((trace.interventions ?? []).length).toBe(1);
      expect((trace.interventions ?? [])[0].severity).toBe("high");
    } finally {
      await session.close();
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("closes sessions idempotently across repeated calls", async () => {
    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false
    });

    await session.start();
    await session.perform({ type: "navigate", url: fixture.baseUrl });

    await Promise.all([session.close(), session.close(), session.close()]);
  }, 120_000);
});
