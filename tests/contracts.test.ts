import { describe, expect, it } from "vitest";
import { parseAction, parseLoopScript, parseScript } from "../src/contracts.js";

describe("contracts", () => {
  it("parses a valid action script", () => {
    const parsed = parseScript({
      settings: {
        headed: false,
        deterministic: true,
        stabilityProfile: "chatty",
        screenshotMode: "fullpage",
        annotateScreenshots: false,
        redactionPack: "strict",
        viewportWidth: 1280,
        viewportHeight: 800,
        maxInterventionsRetained: 3,
        interventionRetentionMode: "severity",
        interventionSourceQuotas: {
          overlay: 1,
          cli: 1
        },
        maxActionAttempts: 3,
        retryBackoffMs: 120
      },
      actions: [
        {
          type: "navigate",
          url: "http://localhost:4173"
        },
        {
          type: "waitFor",
          condition: {
            kind: "network_idle"
          }
        }
      ]
    });

    expect(parsed.actions).toHaveLength(2);
    expect(parsed.actions[0].type).toBe("navigate");
    expect(parsed.settings?.viewportWidth).toBe(1280);
    expect(parsed.settings?.stabilityProfile).toBe("chatty");
    expect(parsed.settings?.screenshotMode).toBe("fullpage");
    expect(parsed.settings?.annotateScreenshots).toBe(false);
    expect(parsed.settings?.redactionPack).toBe("strict");
    expect(parsed.settings?.maxInterventionsRetained).toBe(3);
    expect(parsed.settings?.interventionRetentionMode).toBe("severity");
    expect(parsed.settings?.interventionSourceQuotas?.overlay).toBe(1);
    expect(parsed.settings?.maxActionAttempts).toBe(3);
    expect(parsed.settings?.retryBackoffMs).toBe(120);
  });

  it("rejects invalid click action with no target", () => {
    expect(() => parseAction({ type: "click" })).toThrowError();
  });

  it("rejects invalid retry settings", () => {
    expect(() =>
      parseScript({
        settings: {
          maxActionAttempts: 0
        },
        actions: [
          {
            type: "snapshot"
          }
        ]
      })
    ).toThrowError();

    expect(() =>
      parseScript({
        settings: {
          interventionSourceQuotas: {
            overlay: -1
          }
        },
        actions: [
          {
            type: "snapshot"
          }
        ]
      })
    ).toThrowError();
  });

  it("parses target by semantic role and name", () => {
    const parsed = parseAction({
      type: "click",
      target: {
        kind: "roleName",
        role: "button",
        name: "Sign in"
      }
    });

    expect(parsed.type).toBe("click");
    if (parsed.type === "click") {
      expect(parsed.target?.kind).toBe("roleName");
    }
  });

  it("parses viewport action", () => {
    const parsed = parseAction({
      type: "setViewport",
      width: 1024,
      height: 768
    });

    expect(parsed.type).toBe("setViewport");
    if (parsed.type === "setViewport") {
      expect(parsed.width).toBe(1024);
      expect(parsed.height).toBe(768);
    }
  });

  it("parses assert and consent actions", () => {
    const assertAction = parseAction({
      type: "assert",
      condition: {
        kind: "selector",
        selector: "#status",
        textContains: "ready"
      }
    });
    expect(assertAction.type).toBe("assert");

    const consentAction = parseAction({
      type: "handleConsent",
      mode: "accept",
      requireFound: true,
      strategy: "auto",
      region: "eu",
      siteAdapter: "github.com"
    });
    expect(consentAction.type).toBe("handleConsent");
    if (consentAction.type === "handleConsent") {
      expect(consentAction.region).toBe("eu");
      expect(consentAction.siteAdapter).toBe("github.com");
    }

    const bboxAssert = parseAction({
      type: "assert",
      condition: {
        kind: "selector_bbox_min",
        selector: "button",
        minWidth: 44,
        minHeight: 24
      }
    });
    expect(bboxAssert.type).toBe("assert");

    const overlapAssert = parseAction({
      type: "assert",
      condition: {
        kind: "selector_overlap_max",
        selectorA: "#left",
        selectorB: "#right",
        maxOverlapRatio: 0.1
      }
    });
    expect(overlapAssert.type).toBe("assert");

    const visualAssert = parseAction({
      type: "assert",
      condition: {
        kind: "visual_baseline",
        baselinePath: "reports/baselines/home.png",
        maxMismatchRatio: 0.01,
        threshold: 0.1,
        diffPath: "reports/visual-diff/home.diff.png"
      }
    });
    expect(visualAssert.type).toBe("assert");

    const pauseAction = parseAction({
      type: "pause",
      mode: "timeout",
      timeoutMs: 200,
      note: "manual-check"
    });
    expect(pauseAction.type).toBe("pause");

    const profileSwitch = parseAction({
      type: "switchProfile",
      profile: "admin",
      profilesRoot: ".agent-browser/profiles",
      waitUntil: "domcontentloaded"
    });
    expect(profileSwitch.type).toBe("switchProfile");
    if (profileSwitch.type === "switchProfile") {
      expect(profileSwitch.profile).toBe("admin");
    }

    const networkWait = parseAction({
      type: "waitFor",
      condition: {
        kind: "network_response",
        urlContains: "/api/",
        method: "GET",
        statusMin: 200,
        statusMax: 299,
        bodyIncludes: "ready"
      }
    });
    expect(networkWait.type).toBe("waitFor");

    const checkpointAction = parseAction({
      type: "checkpoint",
      name: "after-login",
      rootDir: ".agent-browser/checkpoints"
    });
    expect(checkpointAction.type).toBe("checkpoint");
    if (checkpointAction.type === "checkpoint") {
      expect(checkpointAction.name).toBe("after-login");
    }
  });

  it("rejects network_response wait without predicates", () => {
    expect(() =>
      parseAction({
        type: "waitFor",
        condition: {
          kind: "network_response"
        }
      })
    ).toThrowError();
  });

  it("parses loop scripts with snapshot and assert predicates", () => {
    const parsed = parseLoopScript({
      settings: {
        headed: false,
        deterministic: true
      },
      setupActions: [
        {
          type: "navigate",
          url: "https://example.com"
        }
      ],
      stepAction: {
        type: "click",
        target: {
          kind: "css",
          selector: "button"
        }
      },
      maxIterations: 6,
      branches: [
        {
          label: "stop",
          when: [
            {
              kind: "snapshot",
              field: "url",
              operator: "contains",
              value: "done"
            }
          ],
          next: "break"
        },
        {
          label: "continue",
          when: [
            {
              kind: "assert",
              condition: {
                kind: "selector",
                selector: "button",
                state: "visible"
              },
              negate: false
            }
          ],
          actions: [
            {
              type: "waitFor",
              condition: {
                kind: "timeout",
                ms: 20
              }
            }
          ],
          next: "continue"
        }
      ]
    });

    expect(parsed.maxIterations).toBe(6);
    expect(parsed.stepAction.type).toBe("click");
    expect(parsed.branches).toHaveLength(2);
    expect(parsed.branches[0].when?.[0].kind).toBe("snapshot");
    expect(parsed.branches[1].when?.[0].kind).toBe("assert");
  });
});
