import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runLoop } from "../src/loop.js";
import { AgentSession } from "../src/session.js";
import { startFixtureServer, type RunningFixtureServer } from "./helpers/fixtureServer.js";

describe("loop runner integration", () => {
  let fixture: RunningFixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("runs action-observe-branch iterations until break", async () => {
    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false
    });

    try {
      await session.start();

      const report = await runLoop(session, {
        setupActions: [
          {
            type: "navigate",
            url: `${fixture.baseUrl}/loop.html`
          }
        ],
        stepAction: {
          type: "click",
          target: {
            kind: "css",
            selector: "#increment"
          }
        },
        branches: [
          {
            label: "done",
            when: [
              {
                kind: "assert",
                condition: {
                  kind: "selector",
                  selector: "#status",
                  textContains: "done"
                }
              }
            ],
            next: "break"
          },
          {
            label: "continue",
            next: "continue"
          }
        ],
        maxIterations: 6
      });

      expect(report.stopReason).toBe("branch_break");
      expect(report.iterations).toHaveLength(3);
      const last = report.iterations[report.iterations.length - 1];
      expect(last.selectedBranchLabel).toBe("done");
      expect(last.observationSnapshot?.url).toContain("loop.html");
    } finally {
      await session.close();
    }
  }, 120_000);

  it("stops with no_branch_match when no branch predicates pass", async () => {
    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false
    });

    try {
      await session.start();

      const report = await runLoop(session, {
        setupActions: [
          {
            type: "navigate",
            url: `${fixture.baseUrl}/loop.html`
          }
        ],
        stepAction: {
          type: "click",
          target: {
            kind: "css",
            selector: "#increment"
          }
        },
        branches: [
          {
            label: "never-match",
            when: [
              {
                kind: "snapshot",
                field: "url",
                operator: "contains",
                value: "/never"
              }
            ],
            next: "continue"
          }
        ],
        maxIterations: 4
      });

      expect(report.stopReason).toBe("no_branch_match");
      expect(report.iterations).toHaveLength(1);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("stops at max iterations when no break branch is chosen", async () => {
    const session = new AgentSession({
      headed: false,
      deterministic: true,
      captureScreenshots: false
    });

    try {
      await session.start();

      const report = await runLoop(session, {
        setupActions: [
          {
            type: "navigate",
            url: `${fixture.baseUrl}/loop.html`
          }
        ],
        stepAction: {
          type: "click",
          target: {
            kind: "css",
            selector: "#increment"
          }
        },
        branches: [
          {
            label: "always-continue",
            next: "continue"
          }
        ],
        maxIterations: 2
      });

      expect(report.stopReason).toBe("max_iterations");
      expect(report.iterations).toHaveLength(2);
    } finally {
      await session.close();
    }
  }, 120_000);
});
