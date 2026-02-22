import { describe, expect, it } from "vitest";
import { createDefaultPluginRegistry, PluginRegistry, resolveConsentHooksWithRegistry } from "../src/plugin-registry.js";

describe("plugin registry", () => {
  it("resolves consent hooks through ordered site/cmp/generic plugins", () => {
    const resolved = resolveConsentHooksWithRegistry({
      mode: "accept",
      strategy: "auto",
      siteAdapter: "github.com",
      url: "https://github.com/login",
      region: "eu"
    });

    expect(resolved.adapterLabel).toBe("site:github.com");
    expect(resolved.pluginIds).toContain("consent.site-adapter");
    expect(resolved.pluginIds).toContain("consent.cmp");
    expect(resolved.pluginIds).toContain("consent.generic");
    expect(resolved.selectors.some((selector) => selector.includes("onetrust"))).toBe(true);
    expect(resolved.selectors.some((selector) => selector.includes("cookie-consent"))).toBe(true);
    expect(resolved.namePatterns.length).toBeGreaterThan(0);
  });

  it("honors cmp-only strategy for consent resolution", () => {
    const registry = createDefaultPluginRegistry();
    const resolved = registry.resolveConsent({
      mode: "reject",
      strategy: "cmp",
      url: "https://example.com",
      host: "example.com",
      region: "global"
    });

    expect(resolved.pluginIds).toContain("consent.cmp");
    expect(resolved.pluginIds).not.toContain("consent.generic");
    expect(resolved.namePatterns).toHaveLength(0);
  });

  it("supports login plugin registration in the shared registry", () => {
    const registry = new PluginRegistry();
    registry.registerLoginPlugin({
      kind: "login",
      id: "login.github",
      priority: 10,
      supports: ({ host }) => host.endsWith("github.com")
    });

    expect(registry.listLoginPluginIds()).toEqual(["login.github"]);
  });
});
