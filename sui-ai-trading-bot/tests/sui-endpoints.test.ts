import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUI_GRPC_FALLBACK_URLS,
  resolveSuiGrpcEndpoints,
} from "../apps/worker/src/suiEndpoints.ts";

describe("shared Sui read endpoint binding", () => {
  it("uses the REAL testnet endpoint without a cross-network fallback", () => {
    const endpoints = resolveSuiGrpcEndpoints({
      MODE: "REAL_TRADECAP",
      REAL_SUI_GRPC_URL: "https://fullnode.testnet.sui.io:443",
    });

    expect(endpoints).toEqual({
      primary: "https://fullnode.testnet.sui.io:443",
      fallbacks: [],
      network: "testnet",
    });
    expect(JSON.stringify(endpoints)).not.toContain("mainnet");
  });

  it("keeps PAPER's mainnet endpoint defaults unchanged", () => {
    expect(resolveSuiGrpcEndpoints({ MODE: "PAPER" })).toEqual({
      primary: undefined,
      fallbacks: [...DEFAULT_SUI_GRPC_FALLBACK_URLS],
      network: "mainnet",
    });
  });

  it("keeps explicit endpoint overrides in REAL mode", () => {
    expect(
      resolveSuiGrpcEndpoints({
        MODE: "REAL_TRADECAP",
        REAL_SUI_GRPC_URL: "https://fullnode.testnet.sui.io:443",
        SUI_GRPC_URL: "https://primary.test:443",
        SUI_GRPC_FALLBACK_URLS:
          "https://fallback-a.test:443, https://fallback-b.test:443",
      }),
    ).toEqual({
      primary: "https://primary.test:443",
      fallbacks: ["https://fallback-a.test:443", "https://fallback-b.test:443"],
      network: "testnet",
    });
  });

  it("fails closed before a REAL worker can fall through to the mainnet SDK default", () => {
    expect(() => resolveSuiGrpcEndpoints({ MODE: "REAL_TRADECAP" })).toThrow(
      "REAL_SUI_GRPC_URL_REQUIRED",
    );
  });
});
