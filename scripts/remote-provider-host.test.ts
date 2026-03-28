import { describe, expect, it } from "vitest";

import {
  buildRemoteProviderHostEnv,
  formatRemoteProviderHostSummary,
  parseRemoteProviderHostArgs,
  resolveAdvertisedBaseUrl,
} from "./remote-provider-host";

describe("parseRemoteProviderHostArgs", () => {
  it("applies CLI overrides and preserves explicit secrets", () => {
    const parsed = parseRemoteProviderHostArgs(
      [
        "--host",
        "0.0.0.0",
        "--port",
        "4010",
        "--advertise-host",
        "100.101.102.103",
        "--secret",
        "bridge-secret",
        "--claude",
        "--mode",
        "start",
      ],
      {},
    );

    expect(parsed.host).toBe("0.0.0.0");
    expect(parsed.port).toBe(4010);
    expect(parsed.advertiseHost).toBe("100.101.102.103");
    expect(parsed.bridgeSecret).toBe("bridge-secret");
    expect(parsed.bridgeSecretGenerated).toBe(false);
    expect(parsed.enableClaudeProvider).toBe(true);
    expect(parsed.mode).toBe("start");
  });

  it("falls back to env and generates a secret when missing", () => {
    const parsed = parseRemoteProviderHostArgs([], {
      OCICODE_HOST: "127.0.0.1",
      OCICODE_PORT: "4788",
      OCICODE_ENABLE_CLAUDE_PROVIDER: "true",
    });

    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(4788);
    expect(parsed.enableClaudeProvider).toBe(true);
    expect(parsed.bridgeSecretGenerated).toBe(true);
    expect(parsed.bridgeSecret.length).toBeGreaterThan(0);
  });
});

describe("buildRemoteProviderHostEnv", () => {
  it("sets the required remote bridge environment", () => {
    const env = buildRemoteProviderHostEnv(
      {
        host: "0.0.0.0",
        port: 3773,
        bridgeSecret: "secret",
        bridgeSecretGenerated: false,
        enableClaudeProvider: true,
        mode: "dev",
      },
      {
        ANTHROPIC_API_KEY: "stale-key",
        ANTHROPIC_AUTH_TOKEN: "stale-token",
      },
    );

    expect(env.OCICODE_MODE).toBe("web");
    expect(env.OCICODE_HOST).toBe("0.0.0.0");
    expect(env.OCICODE_PORT).toBe("3773");
    expect(env.OCICODE_NO_BROWSER).toBe("1");
    expect(env.OCICODE_ENABLE_REMOTE_PROVIDER_MODE).toBe("1");
    expect(env.OCICODE_PROVIDER_BRIDGE_SHARED_SECRET).toBe("secret");
    expect(env.OCICODE_ENABLE_CLAUDE_PROVIDER).toBe("1");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });
});

describe("remote provider host summary helpers", () => {
  it("formats an advertised URL when advertiseHost is set", () => {
    const options = {
      host: "0.0.0.0",
      port: 3773,
      advertiseHost: "100.101.102.103",
      bridgeSecret: "secret",
      bridgeSecretGenerated: false,
      enableClaudeProvider: false,
      mode: "dev" as const,
    };

    expect(resolveAdvertisedBaseUrl(options)).toBe("http://100.101.102.103:3773");
    expect(formatRemoteProviderHostSummary(options)).toContain(
      "Laptop A remote bridge URL: http://100.101.102.103:3773",
    );
  });
});
