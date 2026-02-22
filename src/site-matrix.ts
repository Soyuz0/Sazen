#!/usr/bin/env node

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import process from "node:process";
import { parseScript } from "./contracts.js";
import { AgentSession } from "./session.js";
import type { Action, AgentSessionOptions } from "./types.js";

interface SiteRunSummary {
  site: string;
  scriptPath: string;
  actions: number;
  failedActions: number;
  timedOut: boolean;
  durationMs: number;
  status: "ok" | "failed";
  tracePath: string;
}

interface MatrixSummary {
  createdAt: string;
  options: {
    headed: boolean;
    deterministic: boolean;
    stabilityProfile: "fast" | "balanced" | "chatty";
    operationTimeoutMs: number;
    actionTimeoutMs: number;
  };
  totalSites: number;
  failedSites: number;
  sites: SiteRunSummary[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argSet = new Set(args);
  const headed = argSet.has("--headed");
  const deterministic = !argSet.has("--no-deterministic");
  const stabilityProfile = parseStabilityProfileArg(args, "--stability-profile", "balanced");
  const operationTimeoutMs = parsePositiveIntArg(args, "--operation-timeout-ms", 60_000);
  const actionTimeoutMs = parsePositiveIntArg(args, "--action-timeout-ms", 30_000);

  const flowsDir = resolve("examples/site-flows");
  const files = (await readdir(flowsDir))
    .filter((entry) => extname(entry) === ".json")
    .sort((left, right) => left.localeCompare(right));

  if (files.length === 0) {
    throw new Error("No site flow files found in examples/site-flows");
  }

  await mkdir(resolve("reports"), { recursive: true });
  await mkdir(resolve("traces"), { recursive: true });

  const summaries: SiteRunSummary[] = [];

  for (const file of files) {
    const scriptPath = join(flowsDir, file);
    const siteName = basename(file, ".json");
    const tracePath = resolve("traces", `site-${siteName}.json`);
    const startedAt = Date.now();

    console.log(`\n[site] ${siteName}`);

    const raw = await readFile(scriptPath, "utf8");
    const script = parseScript(JSON.parse(raw));

    const sessionOptions: AgentSessionOptions = {
      ...script.settings,
      headed,
      deterministic,
      stabilityProfile,
      actionTimeoutMs,
      captureScreenshots: true
    };

    const session = new AgentSession(sessionOptions);
    let failedActions = 0;
    let timedOut = false;
    let startSucceeded = false;
    try {
      await withTimeout(
        session.start(),
        operationTimeoutMs,
        `Timed out while starting browser session for '${siteName}'`
      );
      startSucceeded = true;

      for (const [index, action] of script.actions.entries()) {
        const perActionTimeoutMs = Math.max(
          operationTimeoutMs,
          resolveActionTimeoutMs(action as Action, sessionOptions.actionTimeoutMs ?? actionTimeoutMs) + 5_000
        );

        let result;
        try {
          result = await withTimeout(
            session.perform(action as Action),
            perActionTimeoutMs,
            `Timed out while executing ${action.type} for '${siteName}'`
          );
        } catch (error) {
          failedActions += 1;
          timedOut = true;
          const message = error instanceof Error ? error.message : String(error);
          console.log(`  TIMEOUT ${index + 1}/${script.actions.length} ${action.type}`);
          console.log(`    error: ${message}`);
          break;
        }

        const marker = result.status === "ok" ? "OK" : result.status.toUpperCase();
        console.log(
          `  ${marker} ${index + 1}/${script.actions.length} ${action.type} ${result.durationMs}ms`
        );
        if (result.status !== "ok") {
          failedActions += 1;
          if (result.error?.message) {
            console.log(`    error: ${result.error.message}`);
          }
        }
      }

      if (!timedOut) {
        await withTimeout(
          session.saveTrace(tracePath),
          operationTimeoutMs,
          `Timed out while saving trace for '${siteName}'`
        );
      }
    } finally {
      if (startSucceeded) {
        await withTimeout(
          session.close(),
          operationTimeoutMs,
          `Timed out while closing session for '${siteName}'`
        ).catch((error) => {
          timedOut = true;
          const message = error instanceof Error ? error.message : String(error);
          console.log(`  WARN close timeout: ${message}`);
        });
      }
    }

    summaries.push({
      site: siteName,
      scriptPath,
      actions: script.actions.length,
      failedActions,
      timedOut,
      durationMs: Date.now() - startedAt,
      status: failedActions === 0 && !timedOut ? "ok" : "failed",
      tracePath
    });
  }

  const failedSites = summaries.filter((entry) => entry.status === "failed").length;
  const matrixSummary: MatrixSummary = {
    createdAt: new Date().toISOString(),
    options: {
      headed,
      deterministic,
      stabilityProfile,
      operationTimeoutMs,
      actionTimeoutMs
    },
    totalSites: summaries.length,
    failedSites,
    sites: summaries
  };

  const summaryPath = resolve("reports/site-matrix-summary.json");
  await writeFile(summaryPath, JSON.stringify(matrixSummary, null, 2), "utf8");

  console.log(`\nCompleted ${summaries.length} site flows; failed sites: ${failedSites}`);
  console.log(`Summary: ${summaryPath}`);

  if (failedSites > 0) {
    process.exitCode = 2;
  }
}

function parsePositiveIntArg(args: string[], flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  if (index === -1) {
    return fallback;
  }

  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flag}: ${value}`);
  }

  return parsed;
}

function parseStabilityProfileArg(
  args: string[],
  flag: string,
  fallback: "fast" | "balanced" | "chatty"
): "fast" | "balanced" | "chatty" {
  const index = args.indexOf(flag);
  if (index === -1) {
    return fallback;
  }

  const raw = args[index + 1];
  if (!raw) {
    throw new Error(`Missing value for ${flag}`);
  }

  if (raw === "fast" || raw === "balanced" || raw === "chatty") {
    return raw;
  }

  throw new Error(`Invalid value for ${flag}: ${raw}`);
}

function resolveActionTimeoutMs(action: Action, fallback: number): number {
  if ("timeoutMs" in action && typeof action.timeoutMs === "number") {
    return action.timeoutMs;
  }
  return fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Matrix runner failed: ${message}`);
  process.exitCode = 1;
});
