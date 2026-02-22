#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { Command } from "commander";
import { cliActionSchema, parseScript } from "./contracts.js";
import { formatEvent } from "./observer.js";
import { detectFlakes, replayTrace } from "./replay.js";
import { AgentSession } from "./session.js";
import { createAgentPageDescription, tokenOptimizedSnapshot } from "./snapshot.js";
import { getTraceTimeline, loadSavedTrace } from "./trace.js";
import type { Action, ActionResult, AgentSessionOptions, ReplayMode } from "./types.js";

const program = new Command();
program
  .name("agent-browser")
  .description("Agent-first visible Chromium runtime")
  .version("0.1.0");

configureOpenCommand(program);
configureInspectCommand(program);
configureRunCommand(program);
configureActionCommand(program);
configureSnapshotCommand(program);
configureDescribeCommand(program);
configureLoadCommand(program);
configureReplayCommand(program);
configureFlakeCommand(program);
configureTimelineCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});

function configureOpenCommand(root: Command): void {
  root
    .command("open")
    .description("Open a URL in headed browser and stream real-time logs")
    .argument("<url>", "URL to navigate to")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms", "0")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT", "1440x920")
    .option("--raw-logs", "Disable log noise filtering", false)
    .option("--save <name>", "Save session on exit")
    .action(async (url: string, options: Record<string, string | boolean>) => {
      const session = new AgentSession(toSessionOptions(options));
      await session.start();

      const unsubscribe = session.subscribe((event) => {
        console.log(formatEvent(event));
      });

      try {
        const result = await session.perform({ type: "navigate", url });
        printActionResult(result, false);
        console.log("Browser is open. Press Ctrl+C to close.");
        await waitForInterrupt();
      } finally {
        unsubscribe();
        if (typeof options.save === "string" && options.save.length > 0) {
          const manifestPath = await session.saveSession(options.save);
          console.log(`Saved session -> ${manifestPath}`);
        }
        await session.close();
      }
    });
}

function configureInspectCommand(root: Command): void {
  root
    .command("inspect")
    .description("Navigate and print interactive node map")
    .argument("<url>", "URL to inspect")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms", "0")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT", "1440x920")
    .option("--raw-logs", "Disable log noise filtering", false)
    .option("--limit <n>", "Max rows to print", "40")
    .action(async (url: string, options: Record<string, string | boolean>) => {
      const session = new AgentSession(toSessionOptions(options));
      await session.start();

      try {
        const navResult = await session.perform({ type: "navigate", url });
        printActionResult(navResult, false);

        const snapshot = await session.snapshot();
        const interactive = snapshot.nodes.filter((node) => node.interactive);
        const limit = toNumber(options.limit, 40);

        console.log(
          `Interactive nodes: ${interactive.length} | total nodes: ${snapshot.nodeCount} | hash: ${snapshot.domHash}`
        );
        for (const node of interactive.slice(0, limit)) {
          console.log(
            `${node.id} | role=${node.role} | name="${truncate(node.name, 50)}" | ref=${truncate(node.stableRef, 60)}`
          );
        }
      } finally {
        await session.close();
      }
    });
}

function configureRunCommand(root: Command): void {
  root
    .command("run")
    .description("Run a JSON action script")
    .argument("<scriptPath>", "Path to action script JSON")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms", "0")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT", "1440x920")
    .option("--raw-logs", "Disable log noise filtering", false)
    .option("--trace <path>", "Write trace JSON to this path")
    .option("--save <name>", "Save session on completion")
    .option("--logs", "Print captured events after each action", false)
    .action(async (scriptPath: string, options: Record<string, string | boolean>) => {
      const absolutePath = resolve(scriptPath);
      const raw = await readFile(absolutePath, "utf8");
      const script = parseScript(JSON.parse(raw));

      const session = new AgentSession({
        ...toSessionOptions(options),
        ...script.settings
      });

      await session.start();

      let failedActions = 0;
      try {
        for (const [index, action] of script.actions.entries()) {
          console.log(`\nAction ${index + 1}/${script.actions.length}: ${action.type}`);
          const result = await session.perform(action as Action);
          printActionResult(result, Boolean(options.logs));
          if (result.status !== "ok") {
            failedActions += 1;
          }
        }

        if (typeof options.trace === "string" && options.trace.length > 0) {
          const tracePath = await session.saveTrace(options.trace);
          console.log(`\nSaved trace -> ${tracePath}`);
        }

        if (typeof options.save === "string" && options.save.length > 0) {
          const manifestPath = await session.saveSession(options.save);
          console.log(`Saved session -> ${manifestPath}`);
        }

        if (failedActions > 0) {
          process.exitCode = 2;
        }
      } finally {
        await session.close();
      }
    });
}

function configureActionCommand(root: Command): void {
  root
    .command("act")
    .description("Run one action JSON (inline JSON or @file.json)")
    .argument("<action>", "Action JSON string or @path/to/file.json")
    .option("--url <url>", "Navigate before action")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms", "0")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT", "1440x920")
    .option("--raw-logs", "Disable log noise filtering", false)
    .option("--logs", "Print captured events", true)
    .action(async (actionRaw: string, options: Record<string, string | boolean>) => {
      const actionOrActions = await parseActionInput(actionRaw);
      const actions = Array.isArray(actionOrActions) ? actionOrActions : [actionOrActions];

      const session = new AgentSession(toSessionOptions(options));
      await session.start();

      try {
        if (typeof options.url === "string" && options.url.length > 0) {
          const nav = await session.perform({ type: "navigate", url: options.url });
          printActionResult(nav, Boolean(options.logs));
        }

        for (const action of actions) {
          const result = await session.perform(action as Action);
          printActionResult(result, Boolean(options.logs));
        }
      } finally {
        await session.close();
      }
    });
}

function configureSnapshotCommand(root: Command): void {
  root
    .command("snapshot")
    .description("Navigate and print token-optimized snapshot JSON")
    .argument("<url>", "URL to snapshot")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms", "0")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT", "1440x920")
    .option("--raw-logs", "Disable log noise filtering", false)
    .action(async (url: string, options: Record<string, string | boolean>) => {
      const session = new AgentSession(toSessionOptions(options));
      await session.start();

      try {
        await session.perform({ type: "navigate", url });
        const snapshot = await session.snapshot();
        console.log(JSON.stringify(tokenOptimizedSnapshot(snapshot), null, 2));
      } finally {
        await session.close();
      }
    });
}

function configureDescribeCommand(root: Command): void {
  root
    .command("describe")
    .description("Navigate and emit agent-oriented page description JSON")
    .argument("<url>", "URL to describe")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms", "0")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT", "1440x920")
    .option("--raw-logs", "Disable log noise filtering", false)
    .option("--max-elements <n>", "Max interactive elements in output", "80")
    .action(async (url: string, options: Record<string, string | boolean>) => {
      const session = new AgentSession(toSessionOptions(options));
      await session.start();

      try {
        const navigateResult = await session.perform({ type: "navigate", url });
        const snapshot = await session.snapshot();
        const description = createAgentPageDescription(snapshot, {
          maxElements: toNumber(options.maxElements, 80)
        });

        description.screenshotPath = navigateResult.screenshotPath;
        console.log(JSON.stringify(description, null, 2));
      } finally {
        await session.close();
      }
    });
}

function configureReplayCommand(root: Command): void {
  root
    .command("replay")
    .description("Replay a saved trace and verify deterministic hashes")
    .argument("<tracePath>", "Path to trace JSON")
    .option("--mode <mode>", "Replay mode: strict|relaxed", "strict")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms", "0")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT", "1440x920")
    .option("--raw-logs", "Disable log noise filtering", false)
    .option("--preflight-timeout <ms>", "Preflight timeout per origin in ms", "4000")
    .option("--no-preflight", "Skip replay preflight checks")
    .option("--no-selector-invariants", "Disable selector-level checks in relaxed mode")
    .action(async (tracePath: string, options: Record<string, string | boolean>) => {
      const report = await replayTrace(tracePath, toSessionOptions(options), {
        mode: parseReplayMode(options.mode),
        preflight: options.preflight !== false,
        preflightTimeoutMs: toNumber(options.preflightTimeout, 4_000),
        selectorInvariants: options.selectorInvariants !== false
      });
      console.log(`Trace: ${report.tracePath}`);
      console.log(`Mode: ${report.mode}`);
      if (report.preflight.skipped) {
        console.log("Preflight: skipped");
      } else {
        console.log(`Preflight origins checked: ${report.preflight.checkedOrigins.length}`);
      }
      if (report.invariants.selectorEnabled) {
        console.log(
          `Selector invariants: ${report.invariants.selectorChecks} checks, ${report.invariants.selectorMismatches} mismatches`
        );
      }
      console.log(`Actions: ${report.totalActions}`);
      console.log(`Matched: ${report.matched}`);
      console.log(`Mismatched: ${report.mismatched}`);

      if (report.mismatches.length > 0) {
        for (const mismatch of report.mismatches) {
          console.log(
            `- #${mismatch.index + 1} ${mismatch.actionType} (${mismatch.reason}): expected=${mismatch.expected} actual=${mismatch.actual}`
          );
        }
        process.exitCode = 3;
      }
    });
}

function configureTimelineCommand(root: Command): void {
  root
    .command("timeline")
    .description("Show trace timeline with action-level details")
    .argument("<tracePath>", "Path to trace JSON")
    .option("--limit <n>", "Max timeline rows", "200")
    .option("--json", "Print timeline as JSON", false)
    .action(async (tracePath: string, options: Record<string, string | boolean>) => {
      const { absolutePath, trace } = await loadSavedTrace(tracePath);
      const timeline = getTraceTimeline(trace);
      const limit = Math.max(1, toNumber(options.limit, 200));
      const slice = timeline.slice(0, limit);

      if (Boolean(options.json)) {
        console.log(
          JSON.stringify(
            {
              tracePath: absolutePath,
              total: timeline.length,
              shown: slice.length,
              timeline: slice
            },
            null,
            2
          )
        );
        return;
      }

      console.log(`Trace: ${absolutePath}`);
      console.log(`Timeline rows: ${slice.length}/${timeline.length}`);
      console.log("# | action | status | duration | events | diff | url");

      for (const entry of slice) {
        const diff = `${entry.domDiffSummary.added}/${entry.domDiffSummary.removed}/${entry.domDiffSummary.changed}`;
        console.log(
          [
            String(entry.index + 1).padStart(2, " "),
            pad(entry.actionType, 11),
            pad(entry.status, 15),
            pad(`${entry.durationMs}ms`, 10),
            pad(String(entry.eventCount), 6),
            pad(diff, 9),
            truncate(entry.postUrl || "(unknown)", 70)
          ].join(" | ")
        );
      }
    });
}

function configureFlakeCommand(root: Command): void {
  root
    .command("flake")
    .description("Replay trace repeatedly and report unstable actions")
    .argument("<tracePath>", "Path to trace JSON")
    .option("--runs <n>", "Number of replay runs", "3")
    .option("--mode <mode>", "Replay mode: strict|relaxed", "strict")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms", "0")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT", "1440x920")
    .option("--raw-logs", "Disable log noise filtering", false)
    .option("--preflight-timeout <ms>", "Preflight timeout per origin in ms", "4000")
    .option("--no-preflight", "Skip replay preflight checks")
    .option("--no-selector-invariants", "Disable selector-level checks in relaxed mode")
    .action(async (tracePath: string, options: Record<string, string | boolean>) => {
      const runs = Math.max(2, toNumber(options.runs, 3));
      const mode = parseReplayMode(options.mode);
      const report = await detectFlakes(tracePath, runs, toSessionOptions(options), {
        mode,
        preflight: options.preflight !== false,
        preflightTimeoutMs: toNumber(options.preflightTimeout, 4_000),
        selectorInvariants: options.selectorInvariants !== false
      });

      console.log(`Trace: ${report.tracePath}`);
      console.log(`Mode: ${report.mode}`);
      console.log(`Runs: ${report.runs}`);
      if (report.unstableActions.length === 0) {
        console.log("Unstable actions: none");
        return;
      }

      console.log(`Unstable actions: ${report.unstableActions.length}`);
      for (const unstable of report.unstableActions) {
        console.log(
          `- #${unstable.index + 1} ${unstable.actionType}: mismatched in ${unstable.mismatchRuns}/${report.runs} runs`
        );
      }
      process.exitCode = 4;
    });
}

function configureLoadCommand(root: Command): void {
  root
    .command("load")
    .description("Load a saved session and keep browser open")
    .argument("<name>", "Saved session name")
    .option("--sessions-root <path>", "Session root directory", ".agent-browser/sessions")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms", "0")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT", "1440x920")
    .option("--raw-logs", "Disable log noise filtering", false)
    .action(async (name: string, options: Record<string, string | boolean>) => {
      const rootDir =
        typeof options.sessionsRoot === "string" ? options.sessionsRoot : ".agent-browser/sessions";
      const session = await AgentSession.loadSavedSession(name, toSessionOptions(options), rootDir);
      const unsubscribe = session.subscribe((event) => {
        console.log(formatEvent(event));
      });

      try {
        const snapshot = await session.snapshot();
        console.log(`Loaded session '${name}' at ${snapshot.url}`);
        console.log("Browser is open. Press Ctrl+C to close.");
        await waitForInterrupt();
      } finally {
        unsubscribe();
        await session.close();
      }
    });
}

function toSessionOptions(options: Record<string, string | boolean>): AgentSessionOptions {
  const viewport = parseViewportSize(options.viewport);

  return {
    headed: !Boolean(options.headless),
    deterministic: Boolean(options.deterministic),
    slowMoMs: toNumber(options.slowmo, 0),
    viewportWidth: viewport?.width,
    viewportHeight: viewport?.height,
    logNoiseFiltering: !Boolean(options.rawLogs)
  };
}

function parseReplayMode(raw: string | boolean | undefined): ReplayMode {
  if (typeof raw !== "string") {
    return "strict";
  }

  if (raw === "strict" || raw === "relaxed") {
    return raw;
  }

  throw new Error(`Unsupported replay mode '${raw}'. Use 'strict' or 'relaxed'.`);
}

function parseViewportSize(
  raw: string | boolean | undefined
): { width: number; height: number } | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  const normalized = raw.toLowerCase().replace("x", " ").trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 2) {
    throw new Error(`Invalid viewport '${raw}'. Expected WIDTHxHEIGHT.`);
  }

  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid viewport '${raw}'. Width and height must be positive integers.`);
  }

  return { width, height };
}

async function parseActionInput(input: string): Promise<Action | Action[]> {
  const jsonText = input.startsWith("@") ? await readFile(resolve(input.slice(1)), "utf8") : input;
  const parsed = JSON.parse(jsonText);
  return cliActionSchema.parse(parsed) as Action | Action[];
}

function printActionResult(result: ActionResult, printEvents: boolean): void {
  const marker = result.status === "ok" ? "OK" : result.status.toUpperCase();
  console.log(
    `${marker} ${result.actionId} ${result.action.type} ${result.durationMs}ms diff(+${result.domDiff.summary.added}/-${result.domDiff.summary.removed}/~${result.domDiff.summary.changed}) events=${result.events.length}`
  );

  if (result.error) {
    console.log(`error: ${result.error.message}`);
  }

  if (result.screenshotPath) {
    console.log(`screenshot: ${result.screenshotPath}`);
  }

  if (printEvents) {
    for (const event of result.events) {
      console.log(`  ${formatEvent(event)}`);
    }
  }
}

function toNumber(raw: string | boolean | undefined, fallback: number): number {
  if (typeof raw !== "string") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function truncate(input: string, max = 60): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max - 1)}...`;
}

function pad(input: string, width: number): string {
  if (input.length >= width) {
    return input;
  }
  return `${input}${" ".repeat(width - input.length)}`;
}

function waitForInterrupt(): Promise<void> {
  return new Promise((resolvePromise) => {
    const onSigInt = () => {
      process.off("SIGTERM", onSigTerm);
      resolvePromise();
    };
    const onSigTerm = () => {
      process.off("SIGINT", onSigInt);
      resolvePromise();
    };

    process.once("SIGINT", onSigInt);
    process.once("SIGTERM", onSigTerm);
  });
}
