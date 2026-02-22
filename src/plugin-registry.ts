export interface ConsentPluginContext {
  mode: "accept" | "reject";
  strategy: "auto" | "generic" | "cmp";
  siteAdapter?: string;
  url: string;
  host: string;
  region: "global" | "eu" | "us" | "uk";
}

export interface ConsentPluginResult {
  selectors?: string[];
  namePatterns?: RegExp[];
}

export interface ConsentPlugin {
  kind: "consent";
  id: string;
  priority: number;
  supports: (context: ConsentPluginContext) => boolean;
  resolve: (context: ConsentPluginContext) => ConsentPluginResult;
}

export interface LoginPlugin {
  kind: "login";
  id: string;
  priority: number;
  supports: (context: { url: string; host: string; siteAdapter?: string }) => boolean;
}

export interface ResolvedConsentHooks {
  adapterLabel: string;
  namePatterns: RegExp[];
  selectors: string[];
  pluginIds: string[];
}

export class PluginRegistry {
  private readonly consentPlugins: ConsentPlugin[] = [];
  private readonly loginPlugins: LoginPlugin[] = [];

  registerConsentPlugin(plugin: ConsentPlugin): void {
    this.consentPlugins.push(plugin);
    this.consentPlugins.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  }

  registerLoginPlugin(plugin: LoginPlugin): void {
    this.loginPlugins.push(plugin);
    this.loginPlugins.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  }

  resolveConsent(context: ConsentPluginContext): ResolvedConsentHooks {
    const selectorParts: string[] = [];
    const patternParts: RegExp[] = [];
    const matchedPluginIds: string[] = [];

    for (const plugin of this.consentPlugins) {
      if (!plugin.supports(context)) {
        continue;
      }
      const output = plugin.resolve(context);
      matchedPluginIds.push(plugin.id);
      if (output.selectors) {
        selectorParts.push(...output.selectors);
      }
      if (output.namePatterns) {
        patternParts.push(...output.namePatterns);
      }
    }

    return {
      adapterLabel: deriveConsentAdapterLabel(context, matchedPluginIds),
      selectors: dedupeStringList(selectorParts),
      namePatterns: dedupeRegexList(patternParts),
      pluginIds: matchedPluginIds
    };
  }

  listLoginPluginIds(): string[] {
    return this.loginPlugins.map((plugin) => plugin.id);
  }
}

export function createDefaultPluginRegistry(): PluginRegistry {
  const registry = new PluginRegistry();

  registry.registerConsentPlugin({
    kind: "consent",
    id: "consent.site-adapter",
    priority: 100,
    supports: (context) => resolveSiteSelectorConfig(context).exists,
    resolve: (context) => ({
      selectors: resolveSiteSelectorConfig(context).selectors
    })
  });

  registry.registerConsentPlugin({
    kind: "consent",
    id: "consent.cmp",
    priority: 200,
    supports: (context) => context.strategy !== "generic",
    resolve: (context) => ({
      selectors: cmpSelectorsForMode(context.mode)
    })
  });

  registry.registerConsentPlugin({
    kind: "consent",
    id: "consent.generic",
    priority: 300,
    supports: (context) => context.strategy !== "cmp",
    resolve: (context) => ({
      selectors: genericSelectorsForMode(context.mode),
      namePatterns: [...genericNamePatternsForMode(context.mode), ...regionalNamePatterns(context.mode, context.region)]
    })
  });

  return registry;
}

const DEFAULT_PLUGIN_REGISTRY = createDefaultPluginRegistry();

export function resolveConsentHooksWithRegistry(input: {
  mode: "accept" | "reject";
  strategy: "auto" | "generic" | "cmp";
  siteAdapter?: string;
  url: string;
  region: "global" | "eu" | "us" | "uk";
}): ResolvedConsentHooks {
  return DEFAULT_PLUGIN_REGISTRY.resolveConsent({
    ...input,
    host: getHostFromUrl(input.url)
  });
}

function deriveConsentAdapterLabel(context: ConsentPluginContext, pluginIds: string[]): string {
  const hasSite = pluginIds.includes("consent.site-adapter");
  const hasCmp = pluginIds.includes("consent.cmp");
  const hasGeneric = pluginIds.includes("consent.generic");
  if (hasSite) {
    return `site:${context.siteAdapter || context.host}`;
  }
  if (hasCmp && hasGeneric) {
    return "cmp+generic";
  }
  if (hasCmp) {
    return "cmp";
  }
  return "generic";
}

function cmpSelectorsForMode(mode: "accept" | "reject"): string[] {
  if (mode === "accept") {
    return [
      "#onetrust-accept-btn-handler",
      "button[id*='onetrust-accept']",
      "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
      "button[id*='didomi-notice-agree']",
      "button[data-testid*='consent-accept']"
    ];
  }

  return [
    "#onetrust-reject-all-handler",
    "button[id*='onetrust-reject']",
    "#CybotCookiebotDialogBodyButtonDecline",
    "button[id*='didomi-notice-disagree']",
    "button[data-testid*='consent-reject']"
  ];
}

function genericSelectorsForMode(mode: "accept" | "reject"): string[] {
  if (mode === "accept") {
    return [
      "button[data-testid*='accept']",
      "button[id*='accept']",
      "button[class*='accept']",
      "button[aria-label*='accept' i]",
      "button[name*='accept' i]"
    ];
  }

  return [
    "button[data-testid*='reject']",
    "button[id*='reject']",
    "button[class*='reject']",
    "button[aria-label*='reject' i]",
    "button[name*='reject' i]",
    "button[aria-label*='decline' i]"
  ];
}

function genericNamePatternsForMode(mode: "accept" | "reject"): RegExp[] {
  if (mode === "accept") {
    return [/accept/i, /agree/i, /allow all/i, /allow cookies/i, /ok/i, /got it/i, /continue/i];
  }
  return [/reject/i, /decline/i, /deny/i, /necessary only/i];
}

function regionalNamePatterns(
  mode: "accept" | "reject",
  region: "global" | "eu" | "us" | "uk"
): RegExp[] {
  if (mode === "accept") {
    if (region === "eu") {
      return [/alle akzeptieren/i, /tout accepter/i, /aceptar/i, /accetta/i];
    }
    if (region === "uk" || region === "us") {
      return [/accept all/i, /allow all/i];
    }
    return [];
  }

  if (region === "eu") {
    return [/ablehnen/i, /refuser/i, /rechazar/i, /rifiuta/i, /nur notwendige/i];
  }
  if (region === "uk" || region === "us") {
    return [/reject all/i, /decline all/i];
  }
  return [];
}

function resolveSiteSelectorConfig(context: ConsentPluginContext): {
  exists: boolean;
  selectors: string[];
} {
  const siteSelectors: Record<string, { accept: string[]; reject: string[] }> = {
    "github.com": {
      accept: ["button[data-testid='cookie-consent-accept']", "button[aria-label*='Accept' i]"],
      reject: ["button[data-testid='cookie-consent-reject']", "button[aria-label*='Reject' i]"]
    },
    "bbc.com": {
      accept: ["button[data-testid*='accept']", "button[class*='accept']"],
      reject: ["button[data-testid*='reject']", "button[class*='reject']"]
    },
    "wikipedia.org": {
      accept: ["button[class*='wmf-button']"],
      reject: ["button[data-testid*='reject']"]
    }
  };

  const explicit = context.siteAdapter ?? "";
  const siteConfig =
    siteSelectors[explicit] ??
    Object.entries(siteSelectors).find(([domain]) => context.host === domain || context.host.endsWith(`.${domain}`))?.[1];

  if (!siteConfig) {
    return {
      exists: false,
      selectors: []
    };
  }

  return {
    exists: true,
    selectors: siteConfig[context.mode]
  };
}

function getHostFromUrl(input: string): string {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function dedupeStringList(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

function dedupeRegexList(values: RegExp[]): RegExp[] {
  const seen = new Set<string>();
  const output: RegExp[] = [];
  for (const value of values) {
    const key = `${value.source}|${value.flags}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(value);
  }
  return output;
}
