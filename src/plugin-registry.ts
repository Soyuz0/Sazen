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

export interface LoginPluginContext {
  strategy: "auto" | "generic" | "site";
  siteAdapter?: string;
  url: string;
  host: string;
}

export interface LoginPluginResult {
  usernameSelectors?: string[];
  passwordSelectors?: string[];
  submitSelectors?: string[];
  submitNamePatterns?: RegExp[];
}

export interface LoginPlugin {
  kind: "login";
  id: string;
  priority: number;
  supports: (context: LoginPluginContext) => boolean;
  resolve: (context: LoginPluginContext) => LoginPluginResult;
}

export interface ResolvedConsentHooks {
  adapterLabel: string;
  namePatterns: RegExp[];
  selectors: string[];
  pluginIds: string[];
}

export interface ResolvedLoginHooks {
  adapterLabel: string;
  usernameSelectors: string[];
  passwordSelectors: string[];
  submitSelectors: string[];
  submitNamePatterns: RegExp[];
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

  resolveLogin(context: LoginPluginContext): ResolvedLoginHooks {
    const usernameSelectors: string[] = [];
    const passwordSelectors: string[] = [];
    const submitSelectors: string[] = [];
    const submitNamePatterns: RegExp[] = [];
    const matchedPluginIds: string[] = [];

    for (const plugin of this.loginPlugins) {
      if (!plugin.supports(context)) {
        continue;
      }
      const output = plugin.resolve(context);
      matchedPluginIds.push(plugin.id);
      if (output.usernameSelectors) {
        usernameSelectors.push(...output.usernameSelectors);
      }
      if (output.passwordSelectors) {
        passwordSelectors.push(...output.passwordSelectors);
      }
      if (output.submitSelectors) {
        submitSelectors.push(...output.submitSelectors);
      }
      if (output.submitNamePatterns) {
        submitNamePatterns.push(...output.submitNamePatterns);
      }
    }

    return {
      adapterLabel: deriveLoginAdapterLabel(context, matchedPluginIds),
      usernameSelectors: dedupeStringList(usernameSelectors),
      passwordSelectors: dedupeStringList(passwordSelectors),
      submitSelectors: dedupeStringList(submitSelectors),
      submitNamePatterns: dedupeRegexList(submitNamePatterns),
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

  registry.registerLoginPlugin({
    kind: "login",
    id: "login.site.github",
    priority: 100,
    supports: (context) => {
      const host = context.host;
      const adapter = context.siteAdapter ?? "";
      if (context.strategy === "generic") {
        return false;
      }
      return adapter === "github.com" || host === "github.com" || host.endsWith(".github.com");
    },
    resolve: () => ({
      usernameSelectors: ["input#login_field", "input[name='login']", "input[name='username']"],
      passwordSelectors: ["input#password", "input[name='password']"],
      submitSelectors: ["input[type='submit'][name='commit']", "button[name='commit']", "button[type='submit']"],
      submitNamePatterns: [/sign in/i, /log in/i]
    })
  });

  registry.registerLoginPlugin({
    kind: "login",
    id: "login.generic",
    priority: 300,
    supports: (context) => context.strategy !== "site",
    resolve: () => ({
      usernameSelectors: [
        "input[name='username']",
        "input[name='email']",
        "input[type='email']",
        "input[autocomplete='username']"
      ],
      passwordSelectors: ["input[name='password']", "input[type='password']", "input[autocomplete='current-password']"],
      submitSelectors: ["button[type='submit']", "input[type='submit']"],
      submitNamePatterns: [/sign in/i, /log in/i, /continue/i]
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

export function resolveLoginHooksWithRegistry(input: {
  strategy: "auto" | "generic" | "site";
  siteAdapter?: string;
  url: string;
}): ResolvedLoginHooks {
  return DEFAULT_PLUGIN_REGISTRY.resolveLogin({
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

function deriveLoginAdapterLabel(context: LoginPluginContext, pluginIds: string[]): string {
  if (pluginIds.includes("login.site.github")) {
    return "site:github.com";
  }
  if (pluginIds.includes("login.generic")) {
    return "generic";
  }
  return `site:${context.siteAdapter || context.host || "unknown"}`;
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
