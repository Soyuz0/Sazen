import { describe, expect, it } from "vitest";
import {
  adapterPingResultSchema,
  adapterRequestEnvelopeSchema,
  adapterResponseEnvelopeSchema,
  SDK_CONTRACT_VERSION,
  sessionIdentitySchema,
  supportedAdapterMethods
} from "../src/sdk-contract.js";

describe("sdk contract", () => {
  it("parses valid request envelopes", () => {
    const parsed = adapterRequestEnvelopeSchema.parse({
      id: "req-1",
      method: "performAction",
      params: {
        sessionId: "abc",
        action: {
          type: "snapshot"
        }
      }
    });

    expect(parsed.method).toBe("performAction");
  });

  it("validates response envelopes", () => {
    expect(() =>
      adapterResponseEnvelopeSchema.parse({
        ok: false,
        result: {}
      })
    ).toThrowError();

    const ok = adapterResponseEnvelopeSchema.parse({
      ok: true,
      result: {
        value: 1
      }
    });
    expect(ok.ok).toBe(true);
  });

  it("tracks contract version and core capabilities", () => {
    const ping = adapterPingResultSchema.parse({
      version: "0.1.0",
      sdkContractVersion: SDK_CONTRACT_VERSION,
      capabilities: [...supportedAdapterMethods]
    });

    expect(ping.sdkContractVersion).toBe("1.0.0");
    expect(ping.capabilities).toContain("createSession");
  });

  it("parses explicit session identity envelopes", () => {
    const identity = sessionIdentitySchema.parse({
      adapterSessionId: "adapter-1",
      runtimeSessionId: "runtime-1",
      runtimeTabId: "tab_1"
    });

    expect(identity.runtimeTabId).toBe("tab_1");
  });
});
