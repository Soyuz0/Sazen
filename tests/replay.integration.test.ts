import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectFlakes, replayTrace } from "../src/replay.js";
import { AgentSession } from "../src/session.js";
import type { SavedTrace } from "../src/types.js";
import { startFixtureServer, type RunningFixtureServer } from "./helpers/fixtureServer.js";

describe("replay", () => {
  let fixture: RunningFixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("supports strict and relaxed replay modes", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sazen-replay-"));
    const tracePath = join(tempDir, "trace.json");

    await createFixtureTrace(tracePath, fixture.baseUrl);

    const rawTrace = await readFile(tracePath, "utf8");
    const trace = JSON.parse(rawTrace) as SavedTrace;
    trace.records[0].result.postDomHash = "deadbeefdeadbeef";
    await writeFile(tracePath, JSON.stringify(trace, null, 2), "utf8");

    try {
      const strict = await replayTrace(
        tracePath,
        {
          headed: false,
          deterministic: true,
          captureScreenshots: false,
          artifactsDir: tempDir
        },
        {
          mode: "strict",
          preflight: true,
          preflightTimeoutMs: 1_000
        }
      );

      expect(strict.mismatched).toBeGreaterThanOrEqual(1);
      expect(strict.mismatches[0]?.reason).toBe("dom_hash");

      const relaxed = await replayTrace(
        tracePath,
        {
          headed: false,
          deterministic: true,
          captureScreenshots: false,
          artifactsDir: tempDir
        },
        {
          mode: "relaxed",
          preflight: true,
          preflightTimeoutMs: 1_000
        }
      );

      expect(relaxed.mismatched).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails early when preflight origins are unreachable", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sazen-preflight-"));
    const tracePath = join(tempDir, "trace.json");

    const trace: SavedTrace = {
      version: 2,
      createdAt: new Date().toISOString(),
      sessionId: "preflight-test",
      options: {},
      environment: {
        requiredOrigins: ["http://127.0.0.1:9"]
      },
      records: []
    };

    await writeFile(tracePath, JSON.stringify(trace, null, 2), "utf8");

    try {
      await expect(
        replayTrace(
          tracePath,
          {
            headed: false,
            deterministic: true,
            captureScreenshots: false,
            artifactsDir: tempDir
          },
          {
            mode: "strict",
            preflight: true,
            preflightTimeoutMs: 200
          }
        )
      ).rejects.toThrowError(/preflight/i);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("reports unstable actions with flake detection", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sazen-flake-"));
    const tracePath = join(tempDir, "trace.json");

    await createFixtureTrace(tracePath, fixture.baseUrl);

    const rawTrace = await readFile(tracePath, "utf8");
    const trace = JSON.parse(rawTrace) as SavedTrace;
    trace.records[0].result.postDomHash = "deadbeefdeadbeef";
    await writeFile(tracePath, JSON.stringify(trace, null, 2), "utf8");

    try {
      const report = await detectFlakes(
        tracePath,
        3,
        {
          headed: false,
          deterministic: true,
          captureScreenshots: false,
          artifactsDir: tempDir
        },
        {
          mode: "strict",
          preflight: true,
          preflightTimeoutMs: 1_000
        }
      );

      expect(report.unstableActions.length).toBeGreaterThan(0);
      expect(report.unstableActions[0].mismatchRuns).toBe(3);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("enforces selector invariants in relaxed mode when available", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sazen-selector-invariant-"));
    const tracePath = join(tempDir, "trace.json");

    await createFixtureTraceWithSelectorWait(tracePath, fixture.baseUrl);

    const rawTrace = await readFile(tracePath, "utf8");
    const trace = JSON.parse(rawTrace) as SavedTrace;
    const waitRecord = trace.records.find((record) => record.action.type === "waitFor");
    if (!waitRecord) {
      throw new Error("Expected waitFor record in trace");
    }
    waitRecord.result.waitForSelector = "#definitely-missing";
    await writeFile(tracePath, JSON.stringify(trace, null, 2), "utf8");

    try {
      const report = await replayTrace(
        tracePath,
        {
          headed: false,
          deterministic: true,
          captureScreenshots: false,
          artifactsDir: tempDir
        },
        {
          mode: "relaxed",
          preflight: true,
          preflightTimeoutMs: 1_000,
          selectorInvariants: true
        }
      );

      expect(report.invariants.selectorEnabled).toBe(true);
      expect(report.invariants.selectorChecks).toBeGreaterThan(0);
      expect(report.mismatches.some((entry) => entry.reason === "selector_invariant")).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 120_000);
});

async function createFixtureTrace(tracePath: string, baseUrl: string): Promise<void> {
  const session = new AgentSession({
    headed: false,
    deterministic: true,
    captureScreenshots: false
  });

  try {
    await session.start();
    await session.perform({ type: "navigate", url: baseUrl });
    await session.perform({ type: "snapshot" });
    await session.saveTrace(tracePath);
  } finally {
    await session.close();
  }
}

async function createFixtureTraceWithSelectorWait(tracePath: string, baseUrl: string): Promise<void> {
  const session = new AgentSession({
    headed: false,
    deterministic: true,
    captureScreenshots: false
  });

  try {
    await session.start();
    await session.perform({ type: "navigate", url: baseUrl });
    await session.perform({
      type: "waitFor",
      condition: {
        kind: "selector",
        selector: "#login-form",
        state: "visible"
      }
    });
    await session.perform({ type: "snapshot" });
    await session.saveTrace(tracePath);
  } finally {
    await session.close();
  }
}
