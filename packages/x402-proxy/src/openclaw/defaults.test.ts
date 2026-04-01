import { describe, expect, it } from "vitest";
import {
  DEFAULT_MPP_SESSION_BUDGET,
  DEFAULT_PROVIDER_PROTOCOL,
  DEFAULT_SURF_BASE_URL,
  DEFAULT_SURF_PROVIDER_ID,
  DEFAULT_SURF_UPSTREAM_URL,
  resolveProviders,
} from "./defaults.js";

describe("resolveProviders", () => {
  it("defaults to the built-in Surf provider", () => {
    const resolved = resolveProviders({});

    expect(resolved.providers).toHaveLength(1);
    expect(resolved.providers[0]).toMatchObject({
      id: DEFAULT_SURF_PROVIDER_ID,
      baseUrl: DEFAULT_SURF_BASE_URL,
      upstreamUrl: DEFAULT_SURF_UPSTREAM_URL,
      protocol: DEFAULT_PROVIDER_PROTOCOL,
      mppSessionBudget: DEFAULT_MPP_SESSION_BUDGET,
    });
    expect(resolved.models.length).toBeGreaterThan(0);
  });

  it("fills in missing optional provider fields from Surf defaults", () => {
    const resolved = resolveProviders({
      providers: {
        custom: {
          upstreamUrl: "https://example.com/v1",
        },
      },
    });

    expect(resolved.providers[0]).toMatchObject({
      id: "custom",
      baseUrl: DEFAULT_SURF_BASE_URL,
      upstreamUrl: "https://example.com/v1",
      protocol: DEFAULT_PROVIDER_PROTOCOL,
      mppSessionBudget: DEFAULT_MPP_SESSION_BUDGET,
    });
    expect(resolved.providers[0].models.length).toBeGreaterThan(0);
  });

  it("allows provider-level protocol overrides", () => {
    const resolved = resolveProviders({
      protocol: "x402",
      mppSessionBudget: "2",
      providers: {
        custom: {
          protocol: "mpp",
          mppSessionBudget: "5",
        },
      },
    });

    expect(resolved.providers[0]).toMatchObject({
      id: "custom",
      protocol: "mpp",
      mppSessionBudget: "5",
    });
  });
});
