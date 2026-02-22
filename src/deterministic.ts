import type { Page } from "playwright";

export interface DeterministicOptions {
  seed: number;
  fixedTimeMs: number;
  disableAnimations: boolean;
}

export const defaultDeterministicOptions: DeterministicOptions = {
  seed: 1337,
  fixedTimeMs: 1_735_689_600_000,
  disableAnimations: true
};

export async function applyDeterministicSettings(
  page: Page,
  options: DeterministicOptions = defaultDeterministicOptions
): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });

  await page.addInitScript(
    ({ seed, fixedTimeMs, disableAnimations }) => {
      const globalState = (window as unknown as Record<string, unknown>);
      if (globalState.__agentDeterministicApplied) {
        return;
      }
      globalState.__agentDeterministicApplied = true;

      globalState.__agentRandomState = { seed };
      Math.random = () => {
        const state = globalState.__agentRandomState as { seed: number };
        state.seed = (1664525 * state.seed + 1013904223) >>> 0;
        return state.seed / 4294967296;
      };

      const OriginalDate = Date;
      class FixedDate extends OriginalDate {
        constructor(...args: any[]) {
          if (args.length === 0) {
            super(fixedTimeMs);
            return;
          }

          if (args.length === 1) {
            super(args[0]);
            return;
          }

          if (args.length === 2) {
            super(args[0], args[1]);
            return;
          }

          if (args.length === 3) {
            super(args[0], args[1], args[2]);
            return;
          }

          if (args.length === 4) {
            super(args[0], args[1], args[2], args[3]);
            return;
          }

          if (args.length === 5) {
            super(args[0], args[1], args[2], args[3], args[4]);
            return;
          }

          if (args.length === 6) {
            super(args[0], args[1], args[2], args[3], args[4], args[5]);
            return;
          }

          super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
        }

        static now(): number {
          return fixedTimeMs;
        }
      }

      Object.setPrototypeOf(FixedDate, OriginalDate);
      Object.defineProperty(FixedDate, "parse", {
        value: OriginalDate.parse
      });
      Object.defineProperty(FixedDate, "UTC", {
        value: OriginalDate.UTC
      });

      (window as unknown as { Date: typeof Date }).Date = FixedDate as unknown as typeof Date;

      if (disableAnimations) {
        const injectNoMotionStyles = () => {
          if (document.getElementById("__agent_no_motion")) {
            return;
          }
          const style = document.createElement("style");
          style.id = "__agent_no_motion";
          style.textContent = [
            "* , *::before , *::after {",
            "animation-duration: 0s !important;",
            "animation-delay: 0s !important;",
            "transition-duration: 0s !important;",
            "transition-delay: 0s !important;",
            "scroll-behavior: auto !important;",
            "}"
          ].join("");

          if (document.head) {
            document.head.appendChild(style);
          } else {
            document.documentElement.appendChild(style);
          }
        };

        if (document.readyState === "loading") {
          document.addEventListener("DOMContentLoaded", injectNoMotionStyles, { once: true });
        } else {
          injectNoMotionStyles();
        }
      }
    },
    {
      seed: options.seed,
      fixedTimeMs: options.fixedTimeMs,
      disableAnimations: options.disableAnimations
    }
  );
}

export async function installLayoutShiftCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const globalState = window as unknown as Record<string, unknown>;
    if (globalState.__agentLayoutShiftInstalled) {
      return;
    }
    globalState.__agentLayoutShiftInstalled = true;
    globalState.__agentLayoutShifts = [];

    if (!("PerformanceObserver" in window)) {
      return;
    }

    try {
      const observer = new PerformanceObserver((entryList) => {
        const entries = globalState.__agentLayoutShifts as Array<{ value: number; startTime: number }>;
        for (const entry of entryList.getEntries()) {
          const shift = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (shift.hadRecentInput) {
            continue;
          }
          entries.push({
            value: typeof shift.value === "number" ? shift.value : 0,
            startTime: shift.startTime
          });
        }
      });

      observer.observe({ type: "layout-shift", buffered: true });
    } catch {
      // Browser may not support this entry type.
    }
  });
}
