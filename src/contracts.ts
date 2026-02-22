import { z } from "zod";

const nodeTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("node"),
    nodeId: z.string().min(1)
  }),
  z.object({
    kind: z.literal("stableRef"),
    value: z.string().min(1)
  }),
  z.object({
    kind: z.literal("roleName"),
    role: z.string().min(1),
    name: z.string().min(1)
  }),
  z.object({
    kind: z.literal("css"),
    selector: z.string().min(1)
  })
]);

const waitConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("timeout"),
    ms: z.number().int().nonnegative()
  }),
  z.object({
    kind: z.literal("selector"),
    selector: z.string().min(1),
    state: z.enum(["attached", "detached", "visible", "hidden"]).optional()
  }),
  z.object({
    kind: z.literal("network_idle")
  }),
  z.object({
    kind: z.literal("network_response"),
    urlContains: z.string().min(1).optional(),
    urlMatches: z.string().min(1).optional(),
    method: z.string().min(1).optional(),
    status: z.number().int().min(100).max(599).optional(),
    statusMin: z.number().int().min(100).max(599).optional(),
    statusMax: z.number().int().min(100).max(599).optional(),
    bodyIncludes: z.string().min(1).optional(),
    bodyMatches: z.string().min(1).optional(),
    ignoreCase: z.boolean().optional()
  })
]);

const assertConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("selector"),
    selector: z.string().min(1),
    state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
    textContains: z.string().optional()
  }),
  z.object({
    kind: z.literal("selector_bbox_min"),
    selector: z.string().min(1),
    minWidth: z.number().positive(),
    minHeight: z.number().positive(),
    requireCount: z.number().int().positive().optional()
  }),
  z.object({
    kind: z.literal("selector_overlap_max"),
    selectorA: z.string().min(1),
    selectorB: z.string().min(1),
    maxOverlapRatio: z.number().min(0).max(1)
  }),
  z.object({
    kind: z.literal("url_contains"),
    value: z.string().min(1)
  }),
  z.object({
    kind: z.literal("title_contains"),
    value: z.string().min(1)
  }),
  z.object({
    kind: z.literal("visual_baseline"),
    baselinePath: z.string().min(1),
    maxMismatchRatio: z.number().min(0).max(1).optional(),
    threshold: z.number().min(0).max(1).optional(),
    diffPath: z.string().min(1).optional()
  })
]);

const actionBaseSchema = z.object({
  timeoutMs: z.number().int().positive().optional()
});

const actionSchemaCore = z.discriminatedUnion("type", [
  actionBaseSchema.extend({
    type: z.literal("navigate"),
    url: z.string().min(1),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional()
  }),
  actionBaseSchema.extend({
    type: z.literal("click"),
    nodeId: z.string().min(1).optional(),
    target: nodeTargetSchema.optional()
  }),
  actionBaseSchema.extend({
    type: z.literal("fill"),
    value: z.string(),
    nodeId: z.string().min(1).optional(),
    target: nodeTargetSchema.optional()
  }),
  actionBaseSchema.extend({
    type: z.literal("select"),
    value: z.string(),
    nodeId: z.string().min(1).optional(),
    target: nodeTargetSchema.optional()
  }),
  actionBaseSchema.extend({
    type: z.literal("press"),
    key: z.string().min(1)
  }),
  actionBaseSchema.extend({
    type: z.literal("pause"),
    mode: z.enum(["enter", "timeout"]).optional(),
    note: z.string().optional()
  }),
  actionBaseSchema.extend({
    type: z.literal("assert"),
    condition: assertConditionSchema
  }),
  actionBaseSchema.extend({
    type: z.literal("handleConsent"),
    mode: z.enum(["accept", "reject"]).optional(),
    requireFound: z.boolean().optional(),
    strategy: z.enum(["auto", "generic", "cmp"]).optional(),
    siteAdapter: z.string().min(1).optional(),
    region: z.enum(["auto", "global", "eu", "us", "uk"]).optional()
  }),
  actionBaseSchema.extend({
    type: z.literal("handleLogin"),
    username: z.string().min(1),
    password: z.string(),
    strategy: z.enum(["auto", "generic", "site"]).optional(),
    siteAdapter: z.string().min(1).optional(),
    requireFound: z.boolean().optional()
  }),
  actionBaseSchema.extend({
    type: z.literal("waitFor"),
    condition: waitConditionSchema
  }),
  z.object({
    type: z.literal("snapshot")
  }),
  z.object({
    type: z.literal("setViewport"),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  }),
  actionBaseSchema.extend({
    type: z.literal("switchProfile"),
    profile: z.string().min(1),
    profilesRoot: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional()
  }),
  z.object({
    type: z.literal("mock"),
    route: z.object({
      method: z.string().min(1).optional(),
      urlPattern: z.string().min(1),
      status: z.number().int().min(100).max(599).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      contentType: z.string().optional(),
      body: z.string().optional(),
      json: z.unknown().optional()
    })
  }),
  z.object({
    type: z.literal("checkpoint"),
    name: z.string().min(1),
    rootDir: z.string().min(1).optional()
  })
]);

export const actionSchema = actionSchemaCore.superRefine((value, context) => {
  if (value.type === "click" || value.type === "fill" || value.type === "select") {
    if (!value.nodeId && !value.target) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either nodeId or target is required",
        path: ["target"]
      });
    }
  }

  if (value.type === "waitFor" && value.condition.kind === "network_response") {
    const condition = value.condition;
    const hasPredicate =
      condition.urlContains !== undefined ||
      condition.urlMatches !== undefined ||
      condition.method !== undefined ||
      condition.status !== undefined ||
      condition.statusMin !== undefined ||
      condition.statusMax !== undefined ||
      condition.bodyIncludes !== undefined ||
      condition.bodyMatches !== undefined;

    if (!hasPredicate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "network_response wait requires at least one predicate (url/method/status/body)",
        path: ["condition", "kind"]
      });
    }

    if (
      condition.statusMin !== undefined &&
      condition.statusMax !== undefined &&
      condition.statusMin > condition.statusMax
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "statusMin must be less than or equal to statusMax",
        path: ["condition", "statusMin"]
      });
    }
  }
});

export const scriptSchema = z.object({
  settings: z
    .object({
      headed: z.boolean().optional(),
      browserOverlay: z.boolean().optional(),
      deterministic: z.boolean().optional(),
      slowMoMs: z.number().int().nonnegative().optional(),
      stabilityProfile: z.enum(["fast", "balanced", "chatty"]).optional(),
      screenshotMode: z.enum(["viewport", "fullpage"]).optional(),
      annotateScreenshots: z.boolean().optional(),
      redactionPack: z.enum(["default", "strict", "off"]).optional(),
      viewportWidth: z.number().int().positive().optional(),
      viewportHeight: z.number().int().positive().optional(),
      actionTimeoutMs: z.number().int().positive().optional(),
      stableWaitMs: z.number().int().nonnegative().optional(),
      captureScreenshots: z.boolean().optional(),
      artifactsDir: z.string().optional(),
      contextAttachments: z.boolean().optional(),
      contextAttachmentsDir: z.string().optional(),
      maxInterventionsRetained: z.number().int().nonnegative().optional(),
      interventionRetentionMode: z.enum(["count", "severity"]).optional(),
      interventionSourceQuotas: z.record(z.string(), z.number().int().nonnegative()).optional(),
      maxActionAttempts: z.number().int().positive().optional(),
      retryBackoffMs: z.number().int().nonnegative().optional(),
      storageStatePath: z.string().optional(),
      logNoiseFiltering: z.boolean().optional()
    })
    .optional(),
  actions: z.array(actionSchema).min(1)
});

const loopPredicateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("snapshot"),
    field: z.enum(["url", "title", "domHash", "nodeCount", "interactiveCount"]),
    operator: z.enum(["contains", "equals", "not_equals", "gt", "gte", "lt", "lte"]),
    value: z.union([z.string(), z.number()]),
    negate: z.boolean().optional()
  }),
  z.object({
    kind: z.literal("assert"),
    condition: assertConditionSchema,
    timeoutMs: z.number().int().positive().optional(),
    negate: z.boolean().optional()
  })
]);

const loopBranchSchema = z.object({
  label: z.string().min(1).optional(),
  match: z.enum(["all", "any"]).optional(),
  when: z.array(loopPredicateSchema).optional(),
  actions: z.array(actionSchema).optional(),
  next: z.enum(["continue", "break"]).optional()
});

export const loopScriptSchema = z.object({
  settings: scriptSchema.shape.settings,
  setupActions: z.array(actionSchema).optional(),
  stepAction: actionSchema,
  branches: z.array(loopBranchSchema).min(1),
  maxIterations: z.number().int().positive().optional(),
  continueOnStepError: z.boolean().optional(),
  captureObservationSnapshot: z.boolean().optional()
});

export const cliActionSchema = z.union([actionSchema, z.array(actionSchema)]);

export type ParsedAction = z.infer<typeof actionSchema>;
export type ParsedScript = z.infer<typeof scriptSchema>;
export type ParsedLoopScript = z.infer<typeof loopScriptSchema>;

export function parseAction(raw: unknown): ParsedAction {
  return actionSchema.parse(raw);
}

export function parseScript(raw: unknown): ParsedScript {
  return scriptSchema.parse(raw);
}

export function parseLoopScript(raw: unknown): ParsedLoopScript {
  return loopScriptSchema.parse(raw);
}
