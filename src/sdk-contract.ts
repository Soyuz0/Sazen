import { z } from "zod";

export const SDK_CONTRACT_VERSION = "1.0.0";

export const supportedAdapterMethods = [
  "ping",
  "createSession",
  "closeSession",
  "performAction",
  "runActions",
  "pauseSession",
  "resumeSession",
  "getSessionState",
  "session.pause",
  "session.resume",
  "session.state",
  "snapshot",
  "describe",
  "saveTrace",
  "saveSession",
  "shutdown"
] as const;

export const sessionIdentitySchema = z.object({
  adapterSessionId: z.string().min(1),
  runtimeSessionId: z.string().min(1),
  runtimeTabId: z.string().min(1)
});

export const adapterRequestEnvelopeSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional()
});

export const adapterResponseEnvelopeSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        message: z.string().min(1)
      })
      .optional()
  })
  .superRefine((value, context) => {
    if (value.ok && value.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "ok responses must not include error"
      });
    }

    if (!value.ok && !value.error) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "failed responses must include error payload"
      });
    }
  });

export const adapterPingResultSchema = z.object({
  version: z.string().min(1),
  sdkContractVersion: z.string().min(1),
  capabilities: z.array(z.string().min(1))
});

export type AdapterRequestEnvelope = z.infer<typeof adapterRequestEnvelopeSchema>;
export type AdapterResponseEnvelope = z.infer<typeof adapterResponseEnvelopeSchema>;
export type SessionIdentityEnvelope = z.infer<typeof sessionIdentitySchema>;
