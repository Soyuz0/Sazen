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
      storageStatePath: z.string().optional(),
      logNoiseFiltering: z.boolean().optional()
    })
    .optional(),
  actions: z.array(actionSchema).min(1)
});

export const cliActionSchema = z.union([actionSchema, z.array(actionSchema)]);

export type ParsedAction = z.infer<typeof actionSchema>;
export type ParsedScript = z.infer<typeof scriptSchema>;

export function parseAction(raw: unknown): ParsedAction {
  return actionSchema.parse(raw);
}

export function parseScript(raw: unknown): ParsedScript {
  return scriptSchema.parse(raw);
}
