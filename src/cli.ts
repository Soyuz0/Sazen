#!/usr/bin/env node

import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { Command } from "commander";
import { AdapterRuntime, type AdapterRequest } from "./adapter.js";
import { ClaudeCodeAdapterBridge } from "./claude-adapter.js";
import { cliActionSchema, parseLoopScript, parseScript } from "./contracts.js";
import { CodexAdapterService } from "./codex-adapter.js";
import {
  buildDriftAggregate,
  buildDriftRecommendationReport,
  loadDriftHistoryFromFile
} from "./drift-monitor.js";
import { renderLiveTimelineTuiFrame, toLiveTimelineEntry, type LiveTimelineEntry } from "./live-timeline.js";
import { OpenCodeAdapterBridge } from "./opencode-adapter.js";
import { runLoop } from "./loop.js";
import { formatEvent } from "./observer.js";
import { detectFlakes, replayTrace } from "./replay.js";
import { buildRunArtifactIndex } from "./run-index.js";
import { SDK_CONTRACT_VERSION } from "./sdk-contract.js";
import { buildSelectorHealthReport, formatSelectorHealthSummary } from "./selector-health.js";
import { AgentSession } from "./session.js";
import { createAgentPageDescription, tokenOptimizedSnapshot } from "./snapshot.js";
import { writeTimelineHtmlReport } from "./timeline-html.js";
import { getTraceTimeline, loadSavedTrace } from "./trace.js";
import { compareTraceVisuals } from "./visual.js";
import type { Action, ActionResult, AgentSessionOptions, ReplayMode, SavedSession } from "./types.js";

const program = new Command();
program
  .name("sazen")
  .description("The agent first broswer")
  .version("0.1.0");

configureOpenCommand(program);
configureInspectCommand(program);
configureRunCommand(program);
configureLoopCommand(program);
configureActionCommand(program);
configureSnapshotCommand(program);
configureDescribeCommand(program);
configureProfileSaveCommand(program);
configureProfileLoadCommand(program);
configureLoadCommand(program);
configureReplayCommand(program);
configureFlakeCommand(program);
configureTimelineCommand(program);
configureBundleCommand(program);
configureRunIndexCommand(program);
configureSelectorHealthCommand(program);
configureDriftMonitorCommand(program);
configureTimelineHtmlCommand(program);
configureVisualDiffCommand(program);
configureAdapterStdioCommand(program);
configureAdapterOpenCodeCommand(program);
configureAdapterClaudeCodeCommand(program);
configureAdapterCodexCommand(program);
configureRunControlCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});

interface CheckpointManifestEntry {
  name: string;
  actionIndex: number;
  actionType: string;
  sessionManifestPath: string;
  reachedAt: string;
  postUrl: string;
  postDomHash: string;
}

interface CheckpointManifest {
  version: 1;
  scriptPath: string;
  scriptHash: string;
  updatedAt: string;
  checkpoints: Record<string, CheckpointManifestEntry>;
}

function configureOpenCommand(root: Command): void {
  root
    .command("open")
    .description("Open a URL in headed browser and stream real-time logs")
    .argument("<url>", "URL to navigate to")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--no-annotate-screenshots", "Disable screenshot action overlays")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
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
        await safeCloseSession(session);
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
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--no-annotate-screenshots", "Disable screenshot action overlays")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
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
        await safeCloseSession(session);
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
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--no-annotate-screenshots", "Disable screenshot action overlays")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
    .option("--raw-logs", "Disable log noise filtering", false)
    .option("--trace <path>", "Write trace JSON to this path")
    .option("--save <name>", "Save session on completion")
    .option("--logs", "Print captured events after each action", false)
    .option("--live-timeline", "Print timeline rows as actions complete", false)
    .option("--live-timeline-mode <mode>", "Live timeline mode: row|tui", "row")
    .option("--timeline-stream <path>", "Write live timeline JSONL stream to file")
    .option("--control-socket <path>", "Enable run control socket at this path")
    .option("--resume-from-checkpoint <name>", "Resume run from a named checkpoint")
    .option("--checkpoint-manifest <path>", "Checkpoint manifest path (default under .sazen/checkpoints)")
    .option(
      "--max-interventions-retained <n>",
      "Retain at most this many intervention journal entries"
    )
    .option(
      "--intervention-retention-mode <mode>",
      "Intervention retention mode: count|severity"
    )
    .option(
      "--intervention-source-quotas <spec>",
      "Per-source intervention quotas (e.g. overlay=1,cli=1)"
    )
    .option("--max-action-attempts <n>", "Maximum attempts per action before failing")
    .option("--retry-backoff-ms <n>", "Delay between retry attempts in milliseconds")
    .action(async (scriptPath: string, options: Record<string, string | boolean>) => {
      const absolutePath = resolve(scriptPath);
      const raw = await readFile(absolutePath, "utf8");
      const script = parseScript(JSON.parse(raw));
      const scriptHash = computeScriptHash(script);
      const checkpointManifestPath = resolveCheckpointManifestPath(absolutePath, options.checkpointManifest);
      const resumeCheckpointName =
        typeof options.resumeFromCheckpoint === "string" && options.resumeFromCheckpoint.length > 0
          ? options.resumeFromCheckpoint
          : undefined;
      const resumeTarget = resumeCheckpointName
        ? await loadCheckpointResumeTarget({
            checkpointManifestPath,
            checkpointName: resumeCheckpointName,
            scriptPath: absolutePath,
            scriptHash
          })
        : undefined;
      const liveTimelineMode = parseLiveTimelineMode(options.liveTimelineMode);
      const usingLiveTimelineTui =
        Boolean(options.liveTimeline) && liveTimelineMode === "tui" && Boolean(process.stdout.isTTY);

      const sessionOptions: AgentSessionOptions = {
        ...script.settings,
        ...toSessionOptions(options)
      };
      if (resumeTarget) {
        sessionOptions.storageStatePath = resumeTarget.session.storageStatePath;
      }

      const session = new AgentSession(sessionOptions);

      const startActionIndex = resumeTarget ? resumeTarget.actionIndex + 1 : 0;
      const actionsToRun = script.actions.slice(startActionIndex);

      if (typeof options.timelineStream === "string" && options.timelineStream.length > 0) {
        const streamPath = resolve(options.timelineStream);
        await mkdir(dirname(streamPath), { recursive: true });
        await writeFile(streamPath, "", "utf8");
      }

      const controlSocketPath =
        typeof options.controlSocket === "string" && options.controlSocket.length > 0
          ? resolve(options.controlSocket)
          : undefined;

      await session.start();

      let currentActionIndex = -1;
      let completedActions = 0;
      let runFinished = false;
      let runControl: RunControlServer | undefined;

      let failedActions = 0;
      let printedTimelineHeader = false;
      const liveTimelineEntries: LiveTimelineEntry[] = [];
      const runStartedAt = Date.now();
      try {
        runControl = controlSocketPath
          ? await startRunControlServer({
              socketPath: controlSocketPath,
              session,
              getRunState: () => ({
                currentActionIndex,
                completedActions,
                totalActions: actionsToRun.length,
                runFinished,
                currentActionType:
                  currentActionIndex >= 0 && currentActionIndex < actionsToRun.length
                    ? actionsToRun[currentActionIndex].type
                    : undefined,
                resumedFromCheckpoint: resumeTarget?.checkpointName,
                resumedFromActionIndex: resumeTarget?.actionIndex
              })
            })
          : undefined;

        if (runControl && !usingLiveTimelineTui) {
          console.log(`Run control socket: ${runControl.socketPath}`);
        }

        if (resumeTarget) {
          if (!usingLiveTimelineTui) {
            console.log(
              `Resuming from checkpoint '${resumeTarget.checkpointName}' (action ${resumeTarget.actionIndex + 1}/${script.actions.length})`
            );
          }
          const resumeNav = await session.perform({
            type: "navigate",
            url: resumeTarget.session.url,
            waitUntil: "domcontentloaded"
          });
          if (!usingLiveTimelineTui) {
            printActionResult(resumeNav, false);
          }
          if (resumeNav.status !== "ok") {
            throw new Error(
              `Unable to restore checkpoint '${resumeTarget.checkpointName}': ${
                resumeNav.error?.message ?? "navigation failed"
              }`
            );
          }
        }

        if (!resumeTarget && !usingLiveTimelineTui && script.actions.length > 0) {
          console.log(`Starting script from action 1/${script.actions.length}`);
        }

        if (resumeTarget && !usingLiveTimelineTui && actionsToRun.length === 0) {
          console.log("Checkpoint is at end of script; no remaining actions to run.");
        }

        for (const [relativeIndex, action] of actionsToRun.entries()) {
          const absoluteIndex = startActionIndex + relativeIndex;
          currentActionIndex = relativeIndex;
          if (!usingLiveTimelineTui) {
            console.log(`\nAction ${absoluteIndex + 1}/${script.actions.length}: ${action.type}`);
          }
          if (!usingLiveTimelineTui && action.type === "pause" && (action.mode ?? "enter") === "enter") {
            console.log("Pause action active: press Enter to resume (or wait for timeout).");
          }
          const result = await session.perform(action as Action);
          if (!usingLiveTimelineTui) {
            printActionResult(result, Boolean(options.logs));
          }

          if (result.status !== "ok") {
            failedActions += 1;
          }

          if (Boolean(options.liveTimeline)) {
            if (usingLiveTimelineTui) {
              liveTimelineEntries.push(toLiveTimelineEntry(absoluteIndex, result));
              process.stdout.write(
                renderLiveTimelineTuiFrame({
                  entries: liveTimelineEntries,
                  totalActions: actionsToRun.length,
                  completedActions: relativeIndex + 1,
                  failedActions,
                  startedAt: runStartedAt,
                  scriptPath: absolutePath,
                  columns: process.stdout.columns,
                  rows: process.stdout.rows
                })
              );
            } else {
                if (!printedTimelineHeader) {
                  console.log("  # | action | status | duration | events | diff | url");
                  printedTimelineHeader = true;
                }
              console.log(`  ${formatTimelineEntry(absoluteIndex, result)}`);
            }
          }

          if (action.type === "checkpoint" && result.status === "ok" && result.checkpointSummary) {
            await upsertCheckpointManifestEntry({
              checkpointManifestPath,
              scriptPath: absolutePath,
              scriptHash,
              checkpoint: {
                name: result.checkpointSummary.name,
                actionIndex: absoluteIndex,
                actionType: action.type,
                sessionManifestPath: result.checkpointSummary.manifestPath,
                reachedAt: new Date(result.finishedAt).toISOString(),
                postUrl: result.postSnapshot.url,
                postDomHash: result.postSnapshot.domHash
              }
            });
            if (!usingLiveTimelineTui) {
              console.log(`checkpoint: ${result.checkpointSummary.name} -> ${result.checkpointSummary.manifestPath}`);
            }
          }

          if (typeof options.timelineStream === "string" && options.timelineStream.length > 0) {
            const record = {
              index: absoluteIndex,
              actionId: result.actionId,
              actionType: result.action.type,
              status: result.status,
              durationMs: result.durationMs,
              events: result.events.length,
              domDiff: result.domDiff.summary,
              url: result.postSnapshot.url,
              screenshotPath: result.screenshotPath,
              annotatedScreenshotPath: result.annotatedScreenshotPath,
              timestamp: result.finishedAt
            };
            await appendFile(resolve(options.timelineStream), `${JSON.stringify(record)}\n`, "utf8");
          }

          completedActions = relativeIndex + 1;
        }

        runFinished = true;

        if (usingLiveTimelineTui) {
          process.stdout.write("\n");
          console.log(`Run complete: completed=${completedActions}/${actionsToRun.length} failed=${failedActions}`);
          if (runControl) {
            console.log(`Run control socket: ${runControl.socketPath}`);
          }
        }

        if (typeof options.trace === "string" && options.trace.length > 0) {
          const tracePath = await session.saveTrace(options.trace);
          console.log(`\nSaved trace -> ${tracePath}`);
          const companions = await writeTraceCompanionReports(tracePath);
          console.log(`Selector health -> ${companions.selectorHealthPath}`);
          console.log(`Run index -> ${companions.runIndexPath}`);
        }

        if (typeof options.save === "string" && options.save.length > 0) {
          const manifestPath = await session.saveSession(options.save);
          console.log(`Saved session -> ${manifestPath}`);
        }

        if (failedActions > 0) {
          process.exitCode = 2;
        }
      } finally {
        runFinished = true;
        if (runControl) {
          await runControl.close();
        }
        await safeCloseSession(session);
      }
    });
}

function configureLoopCommand(root: Command): void {
  root
    .command("loop")
    .description("Run loop script (action -> observe -> branch)")
    .argument("<loopPath>", "Path to loop script JSON")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--no-annotate-screenshots", "Disable screenshot action overlays")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
    .option("--raw-logs", "Disable log noise filtering", false)
    .option("--trace <path>", "Write trace JSON to this path")
    .option("--save <name>", "Save session on completion")
    .option("--logs", "Print captured events for loop actions", false)
    .option("--max-iterations <n>", "Override script max iterations")
    .option(
      "--max-interventions-retained <n>",
      "Retain at most this many intervention journal entries"
    )
    .option(
      "--intervention-retention-mode <mode>",
      "Intervention retention mode: count|severity"
    )
    .option(
      "--intervention-source-quotas <spec>",
      "Per-source intervention quotas (e.g. overlay=1,cli=1)"
    )
    .option("--max-action-attempts <n>", "Maximum attempts per action before failing")
    .option("--retry-backoff-ms <n>", "Delay between retry attempts in milliseconds")
    .action(async (loopPath: string, options: Record<string, string | boolean>) => {
      const absolutePath = resolve(loopPath);
      const raw = await readFile(absolutePath, "utf8");
      const script = parseLoopScript(JSON.parse(raw));
      const maxIterationsOverride = toOptionalNumber(options.maxIterations);

      const session = new AgentSession({
        ...script.settings,
        ...toSessionOptions(options)
      });

      await session.start();

      try {
        const report = await runLoop(session, {
          ...script,
          maxIterations:
            typeof maxIterationsOverride === "number" && maxIterationsOverride > 0
              ? maxIterationsOverride
              : script.maxIterations
        });

        console.log(`Loop stop reason: ${report.stopReason}`);
        console.log(`Iterations: ${report.iterations.length}/${report.maxIterations}`);

        for (const iteration of report.iterations) {
          console.log(`\nIteration ${iteration.iteration}`);
          printActionResult(iteration.stepResult, Boolean(options.logs));

          if (iteration.observationSnapshot) {
            console.log(
              `observe: url=${truncate(iteration.observationSnapshot.url, 70)} hash=${iteration.observationSnapshot.domHash} nodes=${iteration.observationSnapshot.nodeCount} interactive=${iteration.observationSnapshot.interactiveCount}`
            );
          }

          for (const branch of iteration.branchResults) {
            const marker = branch.matched ? "*" : "-";
            const detail =
              branch.predicates.length > 0
                ? branch.predicates
                    .map((predicate) => `${predicate.passed ? "pass" : "fail"}:${truncate(predicate.detail, 90)}`)
                    .join(" | ")
                : "(no predicates)";
            console.log(`  ${marker} branch ${branch.label} [${branch.matchMode}] ${detail}`);
          }

          if (iteration.selectedBranchLabel) {
            console.log(
              `selected: ${iteration.selectedBranchLabel} next=${iteration.selectedBranchNext ?? "continue"} actions=${iteration.selectedBranchActionResults.length}`
            );
          } else {
            console.log("selected: (none)");
          }

          for (const actionResult of iteration.selectedBranchActionResults) {
            printActionResult(actionResult, Boolean(options.logs));
          }
        }

        if (typeof options.trace === "string" && options.trace.length > 0) {
          const tracePath = await session.saveTrace(options.trace);
          console.log(`\nSaved trace -> ${tracePath}`);
          const companions = await writeTraceCompanionReports(tracePath);
          console.log(`Selector health -> ${companions.selectorHealthPath}`);
          console.log(`Run index -> ${companions.runIndexPath}`);
        }

        if (typeof options.save === "string" && options.save.length > 0) {
          const manifestPath = await session.saveSession(options.save);
          console.log(`Saved session -> ${manifestPath}`);
        }

        if (report.stopReason === "step_error" || report.stopReason === "no_branch_match") {
          process.exitCode = 2;
        }
      } finally {
        await safeCloseSession(session);
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
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--no-annotate-screenshots", "Disable screenshot action overlays")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
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
        await safeCloseSession(session);
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
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--no-annotate-screenshots", "Disable screenshot action overlays")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
    .option("--raw-logs", "Disable log noise filtering", false)
    .action(async (url: string, options: Record<string, string | boolean>) => {
      const session = new AgentSession(toSessionOptions(options));
      await session.start();

      try {
        await session.perform({ type: "navigate", url });
        const snapshot = await session.snapshot();
        console.log(JSON.stringify(tokenOptimizedSnapshot(snapshot), null, 2));
      } finally {
        await safeCloseSession(session);
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
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--no-annotate-screenshots", "Disable screenshot action overlays")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
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
        await safeCloseSession(session);
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
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--no-annotate-screenshots", "Disable screenshot action overlays")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
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

function configureProfileSaveCommand(root: Command): void {
  root
    .command("profile-save")
    .description("Open a URL, allow manual login, then save a named profile")
    .argument("<name>", "Profile name")
    .argument("<url>", "Starting URL")
    .option("--profiles-root <path>", "Profiles root directory", ".sazen/profiles")
    .option("--auto-save-ms <ms>", "Auto-save profile after this many ms")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--no-annotate-screenshots", "Disable screenshot action overlays")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
    .option("--raw-logs", "Disable log noise filtering", false)
    .action(async (name: string, url: string, options: Record<string, string | boolean>) => {
      const profilesRoot =
        typeof options.profilesRoot === "string" ? options.profilesRoot : ".sazen/profiles";
      const session = new AgentSession(toSessionOptions(options));
      await session.start();

      const unsubscribe = session.subscribe((event) => {
        console.log(formatEvent(event));
      });

      try {
        const nav = await session.perform({ type: "navigate", url });
        printActionResult(nav, false);
        const autoSaveMs = toOptionalNumber(options.autoSaveMs);
        if (typeof autoSaveMs === "number" && autoSaveMs > 0) {
          console.log(`Auto-saving profile '${name}' in ${autoSaveMs}ms.`);
        } else {
          console.log(`Complete login/manual setup for profile '${name}', then press Ctrl+C to save.`);
        }

        await waitForInterruptOrTimeout(autoSaveMs);
        const manifestPath = await session.saveSession(name, profilesRoot);
        console.log(`Saved profile -> ${manifestPath}`);
      } finally {
        unsubscribe();
        await safeCloseSession(session);
      }
    });
}

function configureProfileLoadCommand(root: Command): void {
  root
    .command("profile-load")
    .description("Load a named profile and keep browser open")
    .argument("<name>", "Profile name")
    .option("--profiles-root <path>", "Profiles root directory", ".sazen/profiles")
    .option("--close-after-ms <ms>", "Automatically close profile after this many ms")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--no-annotate-screenshots", "Disable screenshot action overlays")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
    .option("--raw-logs", "Disable log noise filtering", false)
    .action(async (name: string, options: Record<string, string | boolean>) => {
      const profilesRoot =
        typeof options.profilesRoot === "string" ? options.profilesRoot : ".sazen/profiles";
      const session = await AgentSession.loadSavedSession(name, toSessionOptions(options), profilesRoot);

      const unsubscribe = session.subscribe((event) => {
        console.log(formatEvent(event));
      });

      try {
        const snapshot = await session.snapshot();
        console.log(`Loaded profile '${name}' at ${snapshot.url}`);
        const closeAfterMs = toOptionalNumber(options.closeAfterMs);
        if (typeof closeAfterMs === "number" && closeAfterMs > 0) {
          console.log(`Auto-closing in ${closeAfterMs}ms.`);
        } else {
          console.log("Browser is open. Press Ctrl+C to close.");
        }

        await waitForInterruptOrTimeout(closeAfterMs);
      } finally {
        unsubscribe();
        await safeCloseSession(session);
      }
    });
}

function configureTimelineCommand(root: Command): void {
  root
    .command("timeline")
    .description("Show trace timeline with action-level details")
    .argument("<tracePath>", "Path to trace JSON")
    .option("--limit <n>", "Max timeline rows", "200")
    .option("--status <status>", "Filter by action status")
    .option("--action <type>", "Filter by action type")
    .option("--artifacts", "Show screenshot path per row", false)
    .option("--annotated-artifacts", "Prefer annotated screenshots in artifact output", false)
    .option("--json", "Print timeline as JSON", false)
    .action(async (tracePath: string, options: Record<string, string | boolean>) => {
      const { absolutePath, trace } = await loadSavedTrace(tracePath);
      const timeline = getTraceTimeline(trace).filter((entry) => {
        if (typeof options.status === "string" && options.status.length > 0) {
          if (entry.status !== options.status) {
            return false;
          }
        }
        if (typeof options.action === "string" && options.action.length > 0) {
          if (entry.actionType !== options.action) {
            return false;
          }
        }
        return true;
      });
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

        if (Boolean(options.artifacts)) {
          const artifactPath = Boolean(options.annotatedArtifacts)
            ? entry.annotatedScreenshotPath ?? entry.screenshotPath
            : entry.screenshotPath ?? entry.annotatedScreenshotPath;

          if (artifactPath) {
            const label = artifactPath === entry.annotatedScreenshotPath ? "annotated" : "screenshot";
            console.log(`    ${label}: ${artifactPath}`);
          }
        }

        if (entry.control) {
          console.log(
            `    control: phase=${entry.control.phase} elapsed=${entry.control.elapsedMs ?? 0}ms sources=${entry.control.sources.join(",") || "none"} urlChanged=${Boolean(entry.control.urlChanged)} domChanged=${Boolean(entry.control.domChanged)}`
          );
          if ((entry.control.hints ?? []).length > 0) {
            console.log(`    hints: ${(entry.control.hints ?? []).join(" | ")}`);
          }
        }
      }
    });
}

function configureBundleCommand(root: Command): void {
  root
    .command("bundle")
    .description("Create a triage bundle from a trace")
    .argument("<tracePath>", "Path to trace JSON")
    .option("--out <dir>", "Output directory", "reports/triage-bundles")
    .option("--copy-artifacts", "Copy screenshot artifacts into the bundle", false)
    .action(async (tracePath: string, options: Record<string, string | boolean>) => {
      const { absolutePath, trace } = await loadSavedTrace(tracePath);
      const timeline = getTraceTimeline(trace);
      const bundleRoot = typeof options.out === "string" ? options.out : "reports/triage-bundles";
      const bundleDir = resolve(bundleRoot, `${Date.now()}-${basename(absolutePath, ".json")}`);

      await mkdir(bundleDir, { recursive: true });

      const traceCopyPath = join(bundleDir, basename(absolutePath));
      await copyFile(absolutePath, traceCopyPath);

      const screenshots = timeline
        .map((entry) => entry.screenshotPath)
        .filter((path): path is string => typeof path === "string");
      const annotatedScreenshots = timeline
        .map((entry) => entry.annotatedScreenshotPath)
        .filter((path): path is string => typeof path === "string");

      const copiedScreenshots: string[] = [];
      if (Boolean(options.copyArtifacts) && screenshots.length + annotatedScreenshots.length > 0) {
        const screenshotsDir = join(bundleDir, "screenshots");
        await mkdir(screenshotsDir, { recursive: true });
        for (const screenshotPath of [...screenshots, ...annotatedScreenshots]) {
          const targetPath = join(screenshotsDir, basename(screenshotPath));
          try {
            await copyFile(screenshotPath, targetPath);
            copiedScreenshots.push(targetPath);
          } catch {
            // Skip missing/unreadable screenshot paths.
          }
        }
      }

      const manifest = {
        createdAt: new Date().toISOString(),
        sourceTracePath: absolutePath,
        copiedTracePath: traceCopyPath,
        totalActions: timeline.length,
        failedActions: timeline.filter((entry) => entry.status !== "ok").length,
        interventions: trace.interventions ?? [],
        screenshots,
        annotatedScreenshots,
        copiedScreenshots,
        timeline
      };

      const manifestPath = join(bundleDir, "bundle.json");
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

      const runIndex = await buildRunArtifactIndex(absolutePath);
      const runIndexPath = join(bundleDir, "run-index.json");
      await writeFile(runIndexPath, JSON.stringify(runIndex, null, 2), "utf8");

      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            ...manifest,
            topErrors: runIndex.topErrors,
            linkedTimelineHtml: runIndex.timelineHtmlPaths,
            linkedVisualDiffReports: runIndex.visualDiffReportPaths,
            linkedBundleManifests: runIndex.bundleManifestPaths,
            runIndexPath
          },
          null,
          2
        ),
        "utf8"
      );

      console.log(`Bundle created: ${bundleDir}`);
      console.log(`- Trace: ${traceCopyPath}`);
      console.log(`- Manifest: ${manifestPath}`);
      console.log(`- Run index: ${runIndexPath}`);
      console.log(`- Screenshot refs: ${screenshots.length}`);
      console.log(`- Annotated refs: ${annotatedScreenshots.length}`);
      console.log(`- Interventions: ${(trace.interventions ?? []).length}`);
      if (Boolean(options.copyArtifacts)) {
        console.log(`- Screenshots copied: ${copiedScreenshots.length}`);
      }
    });
}

function configureRunIndexCommand(root: Command): void {
  root
    .command("run-index")
    .description("Build a canonical run artifact index for a trace")
    .argument("<tracePath>", "Path to trace JSON")
    .option("--out <path>", "Output file or directory", "reports/run-index")
    .option("--json", "Print JSON to stdout", false)
    .action(async (tracePath: string, options: Record<string, string | boolean>) => {
      const index = await buildRunArtifactIndex(tracePath);

      if (Boolean(options.json)) {
        console.log(JSON.stringify(index, null, 2));
      }

      const outputBase = typeof options.out === "string" ? options.out : "reports/run-index";
      const outPath = resolveJsonOutputPath(outputBase, index.tracePath, "run-index");
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(index, null, 2), "utf8");

      console.log(`Run index: ${outPath}`);
      console.log(`- timelineHtml links: ${index.timelineHtmlPaths.length}`);
      console.log(`- visualDiff links: ${index.visualDiffReportPaths.length}`);
      console.log(`- bundles: ${index.bundleManifestPaths.length}`);
    });
}

function configureSelectorHealthCommand(root: Command): void {
  root
    .command("selector-health")
    .description("Analyze selector fragility metrics for a trace")
    .argument("<tracePath>", "Path to trace JSON")
    .option("--out <path>", "Output file or directory", "reports/selector-health")
    .option("--json", "Print JSON to stdout", false)
    .action(async (tracePath: string, options: Record<string, string | boolean>) => {
      const loaded = await loadSavedTrace(tracePath);
      const report = buildSelectorHealthReport(loaded.trace, loaded.absolutePath);

      if (Boolean(options.json)) {
        console.log(JSON.stringify(report, null, 2));
      }

      const outputBase = typeof options.out === "string" ? options.out : "reports/selector-health";
      const outPath = resolveJsonOutputPath(outputBase, loaded.absolutePath, "selector-health");
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");

      console.log(`Selector health: ${outPath}`);
      for (const line of formatSelectorHealthSummary(report)) {
        console.log(`- ${line}`);
      }
    });
}

function configureDriftMonitorCommand(root: Command): void {
  root
    .command("drift-monitor")
    .description("Summarize recurring cross-site drift signatures and recommendations")
    .argument("[historyPath]", "Path to drift history JSON", "reports/drift-monitor/history.json")
    .option("--aggregate <path>", "Aggregate report output path", "reports/drift-monitor/aggregate.json")
    .option("--out <path>", "Recommendation report output path", "reports/drift-monitor/recommendations.json")
    .option("--min-occurrences <n>", "Minimum occurrences for recommendation eligibility", "2")
    .option("--top <n>", "Maximum recommendations", "10")
    .option("--json", "Print full report JSON", false)
    .action(async (historyPath: string, options: Record<string, string | boolean>) => {
      const history = await loadDriftHistoryFromFile(historyPath);
      const aggregate = buildDriftAggregate(history);
      const recommendations = buildDriftRecommendationReport({
        aggregate,
        minOccurrences: Math.max(1, toNumber(options.minOccurrences, 2)),
        top: Math.max(1, toNumber(options.top, 10))
      });

      const aggregatePath = resolve(
        typeof options.aggregate === "string" ? options.aggregate : "reports/drift-monitor/aggregate.json"
      );
      const recommendationsPath = resolve(
        typeof options.out === "string" ? options.out : "reports/drift-monitor/recommendations.json"
      );

      await mkdir(dirname(aggregatePath), { recursive: true });
      await writeFile(aggregatePath, JSON.stringify(aggregate, null, 2), "utf8");

      await mkdir(dirname(recommendationsPath), { recursive: true });
      await writeFile(recommendationsPath, JSON.stringify(recommendations, null, 2), "utf8");

      if (Boolean(options.json)) {
        console.log(
          JSON.stringify(
            {
              historyPath: resolve(historyPath),
              aggregate,
              recommendations
            },
            null,
            2
          )
        );
        return;
      }

      console.log(`Drift history: ${resolve(historyPath)}`);
      console.log(`Aggregate: ${aggregatePath}`);
      console.log(`Recommendations: ${recommendationsPath}`);
      console.log(`- total runs: ${aggregate.totalRuns}`);
      console.log(`- runs with failures: ${aggregate.runsWithFailures}`);
      console.log(`- recurring signatures: ${aggregate.recurringFailures.length}`);
      console.log(`- recommendations: ${recommendations.totalRecommendations}`);

      for (const recommendation of recommendations.recommendations) {
        console.log(
          `  - [${recommendation.priority}] ${recommendation.occurrences}x ${recommendation.signature}`
        );
      }
    });
}

function configureTimelineHtmlCommand(root: Command): void {
  root
    .command("timeline-html")
    .description("Render an interactive HTML timeline report")
    .argument("<tracePath>", "Path to trace JSON")
    .option("--out <dir>", "Output directory", "reports/timeline-html")
    .option("--limit <n>", "Max rows in HTML report")
    .option("--title <text>", "Custom report title")
    .action(async (tracePath: string, options: Record<string, string | boolean>) => {
      const outDir = typeof options.out === "string" ? options.out : "reports/timeline-html";
      const limit = toOptionalNumber(options.limit);
      const title = typeof options.title === "string" ? options.title : undefined;

      const report = await writeTimelineHtmlReport(tracePath, {
        outDir,
        title,
        limit
      });

      console.log(`Timeline HTML: ${report.htmlPath}`);
      console.log(`Rows: ${report.rows}`);
    });
}

function configureVisualDiffCommand(root: Command): void {
  root
    .command("visual-diff")
    .description("Compare screenshots from two traces and create visual diff overlays")
    .argument("<baselineTrace>", "Baseline trace path")
    .argument("<candidateTrace>", "Candidate trace path")
    .option("--out <dir>", "Output directory", "reports/visual-diff")
    .option("--threshold <n>", "Pixelmatch threshold (0-1)", "0.1")
    .option("--fail-ratio <n>", "Fail when mismatch ratio exceeds this value", "0.01")
    .option("--max-steps <n>", "Max number of steps to compare")
    .option("--annotated", "Use annotated screenshots when available", false)
    .option("--json", "Print report as JSON", false)
    .option("--no-write-diffs", "Skip writing diff images")
    .action(async (baselineTrace: string, candidateTrace: string, options: Record<string, string | boolean>) => {
      const report = await compareTraceVisuals(baselineTrace, candidateTrace, {
        outDir: typeof options.out === "string" ? options.out : "reports/visual-diff",
        threshold: toNumber(options.threshold, 0.1),
        maxSteps: toNumber(options.maxSteps, Number.MAX_SAFE_INTEGER),
        writeDiffImages: options.writeDiffs !== false,
        preferAnnotatedArtifacts: Boolean(options.annotated)
      });

      if (Boolean(options.json)) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Baseline: ${report.baselineTracePath}`);
        console.log(`Candidate: ${report.candidateTracePath}`);
        console.log(`Compared: ${report.compared}`);
        console.log(`Different: ${report.different}`);
        console.log(`Missing screenshots: ${report.missing}`);
        console.log(`Size mismatches: ${report.sizeMismatches}`);
      }

      const failRatio = toNumber(options.failRatio, 0.01);
      const severeDiffs = report.entries.filter((entry) => entry.mismatchRatio > failRatio);
      if (severeDiffs.length > 0 || report.sizeMismatches > 0 || report.missing > 0) {
        process.exitCode = 6;
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
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
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
    .option("--sessions-root <path>", "Session root directory", ".sazen/sessions")
    .option("--headless", "Run Chromium headless", false)
    .option("--no-deterministic", "Disable deterministic mode")
    .option("--slowmo <ms>", "Playwright slow motion delay in ms")
    .option("--stability-profile <profile>", "Stability profile: fast|balanced|chatty")
    .option("--viewport <size>", "Viewport size as WIDTHxHEIGHT")
    .option("--screenshot-mode <mode>", "Screenshot mode: viewport|fullpage")
    .option("--redaction-pack <pack>", "Redaction pack: default|strict|off")
    .option("--raw-logs", "Disable log noise filtering", false)
    .action(async (name: string, options: Record<string, string | boolean>) => {
      const rootDir =
        typeof options.sessionsRoot === "string" ? options.sessionsRoot : ".sazen/sessions";
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
        await safeCloseSession(session);
      }
    });
}

function configureAdapterStdioCommand(root: Command): void {
  root
    .command("adapter-stdio")
    .description("Run line-delimited JSON adapter server over stdio")
    .action(async () => {
      const runtime = new AdapterRuntime();
      await runAdapterStdioServer(
        (request) => runtime.handleRequest(request),
        () => runtime.shutdown()
      );
    });
}

function configureAdapterOpenCodeCommand(root: Command): void {
  root
    .command("adapter-opencode")
    .description("Run OpenCode adapter bridge over stdio")
    .action(async () => {
      const runtime = new AdapterRuntime();
      const bridge = new OpenCodeAdapterBridge(runtime);
      await runAdapterStdioServer(
        (request) => bridge.handleRequest(request),
        () => runtime.shutdown()
      );
    });
}

function configureAdapterClaudeCodeCommand(root: Command): void {
  root
    .command("adapter-claude")
    .description("Run Claude Code adapter bridge over stdio")
    .action(async () => {
      const runtime = new AdapterRuntime();
      const bridge = new ClaudeCodeAdapterBridge(runtime);
      await runAdapterStdioServer(
        (request) => bridge.handleRequest(request),
        () => runtime.shutdown()
      );
    });
}

async function runAdapterStdioServer(
  handleRequest: (request: AdapterRequest) => Promise<unknown>,
  shutdownRuntime: () => Promise<void>
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });
  const pending = new Set<Promise<void>>();
  let shutdownPromise: Promise<void> | null = null;

  const writeResponse = (payload: unknown) => {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  const shutdownAdapter = async () => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);

      rl.close();
      await Promise.allSettled([...pending]);
      await shutdownRuntime().catch((error) => {
        if (!isBenignShutdownError(error)) {
          throw error;
        }
      });
    })();

    return shutdownPromise;
  };

  const onSigInt = () => {
    void shutdownAdapter();
  };
  const onSigTerm = () => {
    void shutdownAdapter();
  };

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let request: AdapterRequest;
    try {
      request = JSON.parse(trimmed) as AdapterRequest;
    } catch (error) {
      writeResponse({
        ok: false,
        error: {
          message: `Invalid JSON request: ${error instanceof Error ? error.message : String(error)}`
        }
      });
      continue;
    }

    let task: Promise<void>;
    task = handleRequest(request)
      .then((response) => {
        writeResponse(response);
      })
      .catch((error) => {
        writeResponse({
          id: request.id,
          ok: false,
          error: {
            message: error instanceof Error ? error.message : String(error)
          }
        });
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  }

  await shutdownAdapter();
}

function configureAdapterCodexCommand(root: Command): void {
  root
    .command("adapter-codex")
    .description("Run Codex local HTTP adapter service")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "4242")
    .action(async (options: Record<string, string | boolean>) => {
      const runtime = new AdapterRuntime();
      const service = new CodexAdapterService(runtime);
      const host = typeof options.host === "string" ? options.host : "127.0.0.1";
      const port = Math.max(1, toNumber(options.port, 4_242));
      const server = createHttpServer((request, response) => {
        void handleCodexHttpRequest(request, response, service);
      });

      let shutdownPromise: Promise<void> | null = null;
      const shutdownServer = async () => {
        if (shutdownPromise) {
          return shutdownPromise;
        }

        shutdownPromise = (async () => {
          process.off("SIGTERM", onSigTerm);
          await new Promise<void>((resolvePromise, rejectPromise) => {
            server.close((error) => {
              if (error) {
                rejectPromise(error);
                return;
              }
              resolvePromise();
            });
          }).catch(() => undefined);
          await service.shutdown().catch((error) => {
            if (!isBenignShutdownError(error)) {
              throw error;
            }
          });
        })();

        return shutdownPromise;
      };

      const onSigTerm = () => {
        void shutdownServer();
      };
      process.on("SIGTERM", onSigTerm);

      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(port, host, () => {
          server.off("error", rejectPromise);
          resolvePromise();
        });
      });

      console.log(`Codex adapter listening on http://${host}:${port}`);
      await waitForInterrupt();
      await shutdownServer();
    });
}

async function handleCodexHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  service: CodexAdapterService
): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  try {
    const body = method === "POST" ? await readJsonBody(request) : undefined;
    const result = await service.handleRequest({ method, path, body });
    writeJson(response, result.ok ? 200 : 400, result);
  } catch (error) {
    const payload = {
      ok: false,
      status: "error",
      error: {
        message: error instanceof Error ? error.message : String(error)
      },
      meta: {
        endpoint: path,
        sdkContractVersion: SDK_CONTRACT_VERSION,
        timestamp: new Date().toISOString()
      }
    };
    writeJson(response, 400, payload);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function configureRunControlCommand(root: Command): void {
  root
    .command("run-control")
    .description("Send pause/resume/state command to a run control socket")
    .argument("<command>", "pause|resume|state")
    .requiredOption("--socket <path>", "Control socket path created by run")
    .option("--timeout <ms>", "Request timeout in ms", "5000")
    .option("--json", "Print raw JSON response", false)
    .action(async (command: string, options: Record<string, string | boolean>) => {
      const parsed = parseRunControlCommand(command);
      const socketPath = resolve(String(options.socket));
      const timeoutMs = Math.max(100, toNumber(options.timeout, 5_000));
      const response = await sendRunControlCommand(socketPath, parsed, timeoutMs);

      if (Boolean(options.json)) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      if (!response.ok) {
        throw new Error(response.error?.message ?? "Run control command failed");
      }

      console.log(`Run control: ${response.command}`);
      if (response.state) {
        console.log(
          `- paused=${response.state.paused} pausedMs=${Math.floor(response.state.pausedMs)} sources=${response.state.sources.join(",") || "none"}`
        );
      }
      if (response.run) {
        const currentAction =
          typeof response.run.currentActionType === "string"
            ? response.run.currentActionType
            : response.run.currentActionIndex >= 0
              ? `index:${response.run.currentActionIndex}`
              : "none";
        console.log(
          `- run finished=${response.run.runFinished} current=${currentAction} completed=${response.run.completedActions}/${response.run.totalActions}`
        );
        if (response.run.resumedFromCheckpoint) {
          console.log(
            `- resumedFrom checkpoint=${response.run.resumedFromCheckpoint} actionIndex=${response.run.resumedFromActionIndex}`
          );
        }
      }
      if (response.latestIntervention) {
        console.log(
          `- intervention elapsed=${response.latestIntervention.elapsedMs}ms urlChanged=${response.latestIntervention.urlChanged} domChanged=${response.latestIntervention.domChanged}`
        );
        if ((response.latestIntervention.reconciliationHints ?? []).length > 0) {
          console.log(`- hints: ${response.latestIntervention.reconciliationHints?.join(" | ")}`);
        }
      }
      if (response.interventionJournal) {
        const max =
          typeof response.interventionJournal.maxRetained === "number"
            ? String(response.interventionJournal.maxRetained)
            : "unbounded";
        console.log(
          `- interventionJournal retained=${response.interventionJournal.retained} high=${response.interventionJournal.highImpactRetained} low=${response.interventionJournal.lowImpactRetained} mode=${response.interventionJournal.mode} max=${max}`
        );
        if (response.interventionJournal.sourceQuotas) {
          console.log(
            `- interventionJournal sourceQuotas=${JSON.stringify(response.interventionJournal.sourceQuotas)} retainedBySource=${JSON.stringify(response.interventionJournal.sourceRetained ?? {})}`
          );
        }
        console.log(
          `- interventionJournal trimmed=${response.interventionJournal.trimmed} (high=${response.interventionJournal.trimmedHighImpact}, low=${response.interventionJournal.trimmedLowImpact})`
        );
      }
    });
}

interface RunControlState {
  paused: boolean;
  pausedMs: number;
  sources: string[];
}

interface RunControlRunState {
  currentActionIndex: number;
  completedActions: number;
  totalActions: number;
  runFinished: boolean;
  currentActionType?: string;
  resumedFromCheckpoint?: string;
  resumedFromActionIndex?: number;
}

interface RunControlResponse {
  ok: boolean;
  command: "pause" | "resume" | "state";
  state?: RunControlState;
  run?: RunControlRunState;
  interventionJournal?: {
    retained: number;
    highImpactRetained: number;
    lowImpactRetained: number;
    maxRetained?: number;
    mode: "count" | "severity";
    sourceQuotas?: Record<string, number>;
    sourceRetained?: Record<string, number>;
    trimmed: number;
    trimmedHighImpact: number;
    trimmedLowImpact: number;
  };
  latestIntervention?: {
    elapsedMs: number;
    urlChanged: boolean;
    domChanged: boolean;
    reconciliationHints?: string[];
  };
  error?: {
    message: string;
  };
}

interface RunControlServer {
  socketPath: string;
  close: () => Promise<void>;
}

async function startRunControlServer(input: {
  socketPath: string;
  session: AgentSession;
  getRunState: () => RunControlRunState;
}): Promise<RunControlServer> {
  await mkdir(dirname(input.socketPath), { recursive: true });
  await rm(input.socketPath, { force: true }).catch(() => undefined);

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;

    const writeResponse = (response: RunControlResponse) => {
      socket.end(`${JSON.stringify(response)}\n`);
    };

    socket.on("data", (chunk) => {
      if (handled) {
        return;
      }

      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      handled = true;
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        writeResponse({
          ok: false,
          command: "state",
          error: {
            message: "Empty run control request"
          }
        });
        return;
      }

      let payload: { command?: unknown };
      try {
        payload = JSON.parse(line) as { command?: unknown };
      } catch (error) {
        writeResponse({
          ok: false,
          command: "state",
          error: {
            message: `Invalid JSON request: ${error instanceof Error ? error.message : String(error)}`
          }
        });
        return;
      }

      handleRunControlCommand(input.session, input.getRunState, payload.command)
        .then((response) => {
          writeResponse(response);
        })
        .catch((error) => {
          writeResponse({
            ok: false,
            command: "state",
            error: {
              message: error instanceof Error ? error.message : String(error)
            }
          });
        });
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectPromise(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(input.socketPath);
  });

  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await new Promise<void>((resolvePromise) => {
      server.close(() => {
        resolvePromise();
      });
    });
    await rm(input.socketPath, { force: true }).catch(() => undefined);
  };

  return {
    socketPath: input.socketPath,
    close
  };
}

async function handleRunControlCommand(
  session: AgentSession,
  getRunState: () => RunControlRunState,
  rawCommand: unknown
): Promise<RunControlResponse> {
  const command = parseRunControlCommand(typeof rawCommand === "string" ? rawCommand : "state");

  if (command === "pause") {
    const state = session.pauseExecution("cli");
    return {
      ok: true,
      command,
      state,
      run: getRunState(),
      interventionJournal: session.getInterventionJournalState(),
      latestIntervention: toRunControlIntervention(session.getLatestIntervention())
    };
  }

  if (command === "resume") {
    const state = await session.resumeExecution("cli");
    return {
      ok: true,
      command,
      state,
      run: getRunState(),
      interventionJournal: session.getInterventionJournalState(),
      latestIntervention: toRunControlIntervention(session.getLatestIntervention())
    };
  }

  return {
    ok: true,
    command,
    state: session.getExecutionControlState(),
    run: getRunState(),
    interventionJournal: session.getInterventionJournalState(),
    latestIntervention: toRunControlIntervention(session.getLatestIntervention())
  };
}

function toRunControlIntervention(entry: ReturnType<AgentSession["getLatestIntervention"]>):
  | {
      elapsedMs: number;
      urlChanged: boolean;
      domChanged: boolean;
      reconciliationHints?: string[];
    }
  | undefined {
  if (!entry) {
    return undefined;
  }

  return {
    elapsedMs: entry.elapsedMs,
    urlChanged: entry.urlChanged,
    domChanged: entry.domChanged,
    reconciliationHints: entry.reconciliationHints
  };
}

async function sendRunControlCommand(
  socketPath: string,
  command: "pause" | "resume" | "state",
  timeoutMs: number
): Promise<RunControlResponse> {
  return new Promise<RunControlResponse>((resolvePromise, rejectPromise) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;

    const finishWithError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectPromise(error);
    };

    const finishWithResponse = (response: RunControlResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.end();
      resolvePromise(response);
    };

    const timer = setTimeout(() => {
      finishWithError(new Error(`Run control request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ command })}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        finishWithError(new Error("Run control response was empty"));
        return;
      }

      try {
        const response = JSON.parse(line) as RunControlResponse;
        finishWithResponse(response);
      } catch (error) {
        finishWithError(
          new Error(`Invalid run control response JSON: ${error instanceof Error ? error.message : String(error)}`)
        );
      }
    });

    socket.on("error", (error) => {
      finishWithError(error instanceof Error ? error : new Error(String(error)));
    });

    socket.on("end", () => {
      if (!settled) {
        finishWithError(new Error("Run control socket closed before returning a response"));
      }
    });
  });
}

function parseRunControlCommand(raw: string): "pause" | "resume" | "state" {
  if (raw === "pause" || raw === "resume" || raw === "state") {
    return raw;
  }

  throw new Error(`Unsupported run control command '${raw}'. Use pause, resume, or state.`);
}

function parseLiveTimelineMode(raw: string | boolean | undefined): "row" | "tui" {
  if (typeof raw !== "string") {
    return "row";
  }

  if (raw === "row" || raw === "tui") {
    return raw;
  }

  throw new Error(`Invalid live timeline mode '${raw}'. Use row or tui.`);
}

async function writeTraceCompanionReports(
  tracePath: string
): Promise<{ selectorHealthPath: string; runIndexPath: string }> {
  const loaded = await loadSavedTrace(tracePath);
  const selectorHealth = buildSelectorHealthReport(loaded.trace, loaded.absolutePath);
  const selectorHealthPath = resolveJsonOutputPath(
    "reports/selector-health",
    loaded.absolutePath,
    "selector-health"
  );
  await mkdir(dirname(selectorHealthPath), { recursive: true });
  await writeFile(selectorHealthPath, JSON.stringify(selectorHealth, null, 2), "utf8");

  const runIndex = await buildRunArtifactIndex(loaded.absolutePath);
  const runIndexPath = resolveJsonOutputPath("reports/run-index", loaded.absolutePath, "run-index");
  await mkdir(dirname(runIndexPath), { recursive: true });
  await writeFile(runIndexPath, JSON.stringify(runIndex, null, 2), "utf8");

  return {
    selectorHealthPath,
    runIndexPath
  };
}

function resolveJsonOutputPath(basePath: string, tracePath: string, suffix: string): string {
  const absoluteBase = resolve(basePath);
  if (absoluteBase.endsWith(".json")) {
    return absoluteBase;
  }

  return join(absoluteBase, `${basename(tracePath, ".json")}.${suffix}.json`);
}

function computeScriptHash(script: unknown): string {
  const canonical = JSON.stringify(script);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function resolveCheckpointManifestPath(scriptPath: string, rawPath: string | boolean | undefined): string {
  if (typeof rawPath === "string" && rawPath.length > 0) {
    return resolve(rawPath);
  }

  return resolve(".sazen/checkpoints", `${basename(scriptPath, ".json")}.manifest.json`);
}

async function loadCheckpointResumeTarget(input: {
  checkpointManifestPath: string;
  checkpointName: string;
  scriptPath: string;
  scriptHash: string;
}): Promise<{
  checkpointName: string;
  actionIndex: number;
  session: SavedSession;
}> {
  const rawManifest = await readFile(input.checkpointManifestPath, "utf8").catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Checkpoint manifest '${input.checkpointManifestPath}' is unavailable for resume: ${reason}`
    );
  });

  const parsed = JSON.parse(rawManifest) as CheckpointManifest;
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported checkpoint manifest version '${String(parsed.version)}' in '${input.checkpointManifestPath}'`
    );
  }

  if (parsed.scriptHash !== input.scriptHash) {
    throw new Error(
      [
        `Checkpoint manifest '${input.checkpointManifestPath}' does not match current script content.`,
        `expectedHash=${input.scriptHash}`,
        `manifestHash=${parsed.scriptHash}`,
        "Re-run from start to regenerate checkpoints."
      ].join(" ")
    );
  }

  if (resolve(parsed.scriptPath) !== resolve(input.scriptPath)) {
    throw new Error(
      `Checkpoint manifest '${input.checkpointManifestPath}' targets '${parsed.scriptPath}', not '${input.scriptPath}'`
    );
  }

  const checkpoint = parsed.checkpoints[input.checkpointName];
  if (!checkpoint) {
    const available = Object.keys(parsed.checkpoints).sort((left, right) => left.localeCompare(right));
    throw new Error(
      [
        `Checkpoint '${input.checkpointName}' not found in '${input.checkpointManifestPath}'.`,
        available.length > 0 ? `Available: ${available.join(", ")}` : "No checkpoints are recorded yet."
      ].join(" ")
    );
  }

  const rawSession = await readFile(resolve(checkpoint.sessionManifestPath), "utf8").catch((error) => {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Checkpoint session manifest '${checkpoint.sessionManifestPath}' is unavailable: ${reason}`
    );
  });

  const session = JSON.parse(rawSession) as SavedSession;
  if (!session.storageStatePath || !session.url) {
    throw new Error(`Checkpoint session manifest '${checkpoint.sessionManifestPath}' is incomplete`);
  }

  return {
    checkpointName: checkpoint.name,
    actionIndex: checkpoint.actionIndex,
    session
  };
}

async function upsertCheckpointManifestEntry(input: {
  checkpointManifestPath: string;
  scriptPath: string;
  scriptHash: string;
  checkpoint: CheckpointManifestEntry;
}): Promise<void> {
  const existing = await readCheckpointManifest(input.checkpointManifestPath);

  const manifest: CheckpointManifest =
    existing && existing.scriptHash === input.scriptHash && resolve(existing.scriptPath) === resolve(input.scriptPath)
      ? existing
      : {
          version: 1,
          scriptPath: resolve(input.scriptPath),
          scriptHash: input.scriptHash,
          updatedAt: new Date().toISOString(),
          checkpoints: {}
        };

  manifest.scriptPath = resolve(input.scriptPath);
  manifest.scriptHash = input.scriptHash;
  manifest.updatedAt = new Date().toISOString();
  manifest.checkpoints[input.checkpoint.name] = {
    ...input.checkpoint,
    sessionManifestPath: resolve(input.checkpoint.sessionManifestPath)
  };

  await mkdir(dirname(input.checkpointManifestPath), { recursive: true });
  await writeFile(input.checkpointManifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

async function readCheckpointManifest(checkpointManifestPath: string): Promise<CheckpointManifest | undefined> {
  const raw = await readFile(checkpointManifestPath, "utf8").catch((error) => {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes("enoent") || message.includes("no such file")) {
      return undefined;
    }
    throw error;
  });

  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as CheckpointManifest;
  if (parsed.version !== 1) {
    return undefined;
  }

  return parsed;
}

function toSessionOptions(options: Record<string, string | boolean>): AgentSessionOptions {
  const viewport = parseViewportSize(options.viewport);
  const slowMo = toOptionalNumber(options.slowmo);
  const stabilityProfile = parseStabilityProfile(options.stabilityProfile);
  const screenshotMode = parseScreenshotMode(options.screenshotMode);
  const redactionPack = parseRedactionPack(options.redactionPack);
  const maxInterventionsRetained = toOptionalNumber(options.maxInterventionsRetained);
  const interventionRetentionMode = parseInterventionRetentionMode(options.interventionRetentionMode);
  const interventionSourceQuotas = parseInterventionSourceQuotas(options.interventionSourceQuotas);
  const maxActionAttempts = toOptionalNumber(options.maxActionAttempts);
  const retryBackoffMs = toOptionalNumber(options.retryBackoffMs);

  const result: AgentSessionOptions = {
    viewportWidth: viewport?.width,
    viewportHeight: viewport?.height,
    slowMoMs: slowMo,
    stabilityProfile,
    screenshotMode,
    redactionPack
  };

  if (options.headless === true) {
    result.headed = false;
  }

  if (options.deterministic === false) {
    result.deterministic = false;
  }

  if (options.rawLogs === true) {
    result.logNoiseFiltering = false;
  }

  if (typeof maxInterventionsRetained === "number" && maxInterventionsRetained >= 0) {
    result.maxInterventionsRetained = Math.floor(maxInterventionsRetained);
  }

  if (interventionRetentionMode) {
    result.interventionRetentionMode = interventionRetentionMode;
  }

  if (interventionSourceQuotas) {
    result.interventionSourceQuotas = interventionSourceQuotas;
  }

  if (typeof maxActionAttempts === "number" && maxActionAttempts >= 1) {
    result.maxActionAttempts = Math.floor(maxActionAttempts);
  }

  if (typeof retryBackoffMs === "number" && retryBackoffMs >= 0) {
    result.retryBackoffMs = Math.floor(retryBackoffMs);
  }

  if (isFlagPresent("--no-annotate-screenshots")) {
    result.annotateScreenshots = false;
  }

  return result;
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

function parseStabilityProfile(
  raw: string | boolean | undefined
): AgentSessionOptions["stabilityProfile"] {
  if (typeof raw !== "string") {
    return undefined;
  }

  if (raw === "fast" || raw === "balanced" || raw === "chatty") {
    return raw;
  }

  throw new Error(`Invalid stability profile '${raw}'. Use fast, balanced, or chatty.`);
}

function parseScreenshotMode(
  raw: string | boolean | undefined
): AgentSessionOptions["screenshotMode"] {
  if (typeof raw !== "string") {
    return undefined;
  }

  if (raw === "viewport" || raw === "fullpage") {
    return raw;
  }

  throw new Error(`Invalid screenshot mode '${raw}'. Use viewport or fullpage.`);
}

function parseRedactionPack(
  raw: string | boolean | undefined
): AgentSessionOptions["redactionPack"] {
  if (typeof raw !== "string") {
    return undefined;
  }

  if (raw === "default" || raw === "strict" || raw === "off") {
    return raw;
  }

  throw new Error(`Invalid redaction pack '${raw}'. Use default, strict, or off.`);
}

function parseInterventionRetentionMode(
  raw: string | boolean | undefined
): AgentSessionOptions["interventionRetentionMode"] {
  if (typeof raw !== "string") {
    return undefined;
  }

  if (raw === "count" || raw === "severity") {
    return raw;
  }

  throw new Error(`Invalid intervention retention mode '${raw}'. Use count or severity.`);
}

function parseInterventionSourceQuotas(
  raw: string | boolean | undefined
): AgentSessionOptions["interventionSourceQuotas"] {
  if (typeof raw !== "string") {
    return undefined;
  }

  const quotas: Record<string, number> = {};
  const segments = raw
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  for (const segment of segments) {
    const equalsIndex = segment.indexOf("=");
    if (equalsIndex <= 0 || equalsIndex === segment.length - 1) {
      throw new Error(
        `Invalid intervention source quota segment '${segment}'. Use source=count (e.g. overlay=1).`
      );
    }

    const source = segment.slice(0, equalsIndex).trim();
    const valueRaw = segment.slice(equalsIndex + 1).trim();
    if (source.length === 0) {
      throw new Error(`Invalid intervention source quota segment '${segment}': missing source name.`);
    }

    const value = Number(valueRaw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `Invalid intervention source quota value '${valueRaw}' for '${source}'. Use non-negative integers.`
      );
    }

    quotas[source] = value;
  }

  if (Object.keys(quotas).length === 0) {
    return undefined;
  }

  return quotas;
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

  if (result.annotatedScreenshotPath) {
    console.log(`annotated: ${result.annotatedScreenshotPath}`);
  }

  if (result.pauseSummary) {
    console.log(
      `pause: mode=${result.pauseSummary.mode} elapsed=${result.pauseSummary.elapsedMs}ms urlChanged=${result.pauseSummary.urlChanged} domChanged=${result.pauseSummary.domChanged}`
    );
  }

  if (result.checkpointSummary) {
    console.log(`checkpoint: name=${result.checkpointSummary.name} manifest=${result.checkpointSummary.manifestPath}`);
  }

  if (result.retry) {
    const statuses = result.retry.attempts.map((attempt) => attempt.status).join(" -> ");
    console.log(
      `retry: attempts=${result.retry.attemptCount}/${result.retry.maxAttempts} backoff=${result.retry.backoffMs}ms final=${result.retry.finalReason} statuses=${statuses}`
    );
  }

  if (printEvents) {
    for (const event of result.events) {
      console.log(`  ${formatEvent(event)}`);
    }
  }
}

function formatTimelineEntry(index: number, result: ActionResult): string {
  const diff = `${result.domDiff.summary.added}/${result.domDiff.summary.removed}/${result.domDiff.summary.changed}`;
  return [
    String(index + 1).padStart(2, " "),
    pad(result.action.type, 11),
    pad(result.status, 15),
    pad(`${result.durationMs}ms`, 10),
    pad(String(result.events.length), 6),
    pad(diff, 9),
    truncate(result.postSnapshot.url || "(unknown)", 70)
  ].join(" | ");
}

function toNumber(raw: string | boolean | undefined, fallback: number): number {
  if (typeof raw !== "string") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(raw: string | boolean | undefined): number | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
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
  const waiter = createInterruptWaiter();
  return waiter.promise;
}

async function waitForInterruptOrTimeout(timeoutMs: number | undefined): Promise<void> {
  if (typeof timeoutMs !== "number" || timeoutMs <= 0) {
    await waitForInterrupt();
    return;
  }

  const waiter = createInterruptWaiter();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      waiter.promise,
      new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    waiter.cancel();
  }
}

async function safeCloseSession(session: AgentSession): Promise<void> {
  try {
    await session.close();
  } catch (error) {
    if (isBenignShutdownError(error)) {
      return;
    }
    throw error;
  }
}

function createInterruptWaiter(): { promise: Promise<void>; cancel: () => void } {
  let settled = false;

  const cancel = () => {
    if (settled) {
      return;
    }
    settled = true;
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
  };

  const onSigInt = () => {
    cancel();
    resolvePromise?.();
  };
  const onSigTerm = () => {
    cancel();
    resolvePromise?.();
  };

  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
  });

  return {
    promise,
    cancel
  };
}

function isBenignShutdownError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("target page") ||
    message.includes("target closed") ||
    message.includes("browser has been closed") ||
    message.includes("context closed") ||
    message.includes("already closed") ||
    message.includes("channel closed") ||
    message.includes("connection closed") ||
    message.includes("closed")
  );
}

function isFlagPresent(flag: string): boolean {
  return process.argv.includes(flag);
}
