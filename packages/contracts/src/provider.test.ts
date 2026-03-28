import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "full-access",
      providerOptions: {
        codex: {
          executionMode: "local",
          binaryPath: "/usr/local/bin/codex",
          homePath: "/tmp/.codex",
        },
      },
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("high");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
    expect(parsed.providerOptions?.codex?.executionMode).toBe("local");
    expect(parsed.providerOptions?.codex?.binaryPath).toBe("/usr/local/bin/codex");
    expect(parsed.providerOptions?.codex?.homePath).toBe("/tmp/.codex");
  });

  it("accepts claude-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-2",
      provider: "claudeAgent",
      cwd: "/tmp/workspace",
      model: "claude-sonnet-4-6",
      modelOptions: {
        claudeAgent: {
          effort: "high",
          thinking: true,
        },
      },
      runtimeMode: "full-access",
      providerOptions: {
        claudeAgent: {
          executionMode: "remote",
          binaryPath: "claude",
          remote: {
            baseUrl: "ws://remote-host:3773",
            sharedSecret: "secret",
            workspaceProxyMode: "local-proxy",
          },
        },
      },
    });

    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.modelOptions?.claudeAgent?.effort).toBe("high");
    expect(parsed.providerOptions?.claudeAgent?.executionMode).toBe("remote");
    expect(parsed.providerOptions?.claudeAgent?.remote?.workspaceProxyMode).toBe("local-proxy");
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts provider-scoped model options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      model: "gpt-5.3-codex",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    });

    expect(parsed.model).toBe("gpt-5.3-codex");
    expect(parsed.modelOptions?.codex?.reasoningEffort).toBe("xhigh");
    expect(parsed.modelOptions?.codex?.fastMode).toBe(true);
  });

  it("accepts claude provider-scoped model options", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-2",
      model: "claude-opus-4-6",
      modelOptions: {
        claudeAgent: {
          effort: "ultrathink",
          fastMode: true,
        },
      },
    });

    expect(parsed.model).toBe("claude-opus-4-6");
    expect(parsed.modelOptions?.claudeAgent?.effort).toBe("ultrathink");
    expect(parsed.modelOptions?.claudeAgent?.fastMode).toBe(true);
  });
});
