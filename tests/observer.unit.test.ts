import { describe, expect, it } from "vitest";
import { isLikelyNoiseEvent } from "../src/observer.js";
import type { ObserverEvent } from "../src/types.js";

describe("observer noise filtering", () => {
  it("filters favicon 404 network responses", () => {
    const event: ObserverEvent = {
      kind: "network",
      seq: 1,
      timestamp: Date.now(),
      phase: "response",
      method: "GET",
      url: "https://example.com/favicon.ico",
      resourceType: "image",
      status: 404,
      statusText: "Not Found"
    };

    expect(isLikelyNoiseEvent(event)).toBe(true);
  });

  it("filters known autocomplete console warning", () => {
    const event: ObserverEvent = {
      kind: "console",
      seq: 2,
      timestamp: Date.now(),
      level: "log",
      text: "[DOM] Input elements should have autocomplete attributes",
      location: {}
    };

    expect(isLikelyNoiseEvent(event)).toBe(true);
  });

  it("keeps useful console messages", () => {
    const event: ObserverEvent = {
      kind: "console",
      seq: 3,
      timestamp: Date.now(),
      level: "info",
      text: "user clicked submit",
      location: {}
    };

    expect(isLikelyNoiseEvent(event)).toBe(false);
  });
});
