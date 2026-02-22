import { describe, expect, it } from "vitest";
import { parseAction, parseScript } from "../src/contracts.js";

describe("contracts", () => {
  it("parses a valid action script", () => {
    const parsed = parseScript({
      settings: {
        headed: false,
        deterministic: true,
        viewportWidth: 1280,
        viewportHeight: 800
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
  });

  it("rejects invalid click action with no target", () => {
    expect(() => parseAction({ type: "click" })).toThrowError();
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
});
