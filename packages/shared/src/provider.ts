import type {
  ProviderKind,
  ProviderSessionStartInput,
  ProviderStartOptions,
} from "@ocicode/contracts";

export function getProviderExecutionMode(
  providerOptions: ProviderStartOptions | undefined,
  provider: ProviderKind,
): "disabled" | "local" | "remote" {
  if (provider === "claudeAgent") {
    return providerOptions?.claudeAgent?.executionMode ?? "local";
  }
  return providerOptions?.codex?.executionMode ?? "local";
}

export function getProviderRemoteBridgeConfig(
  providerOptions: ProviderStartOptions | undefined,
  provider: ProviderKind,
): { baseUrl: string; sharedSecret: string } | undefined {
  const remote =
    provider === "claudeAgent"
      ? providerOptions?.claudeAgent?.remote
      : providerOptions?.codex?.remote;
  const baseUrl = remote?.baseUrl?.trim();
  const sharedSecret = remote?.sharedSecret?.trim();
  if (!baseUrl || !sharedSecret) {
    return undefined;
  }
  return { baseUrl, sharedSecret };
}

export function getProviderWorkspaceProxyMode(
  providerOptions: ProviderStartOptions | undefined,
  provider: ProviderKind,
): "local-proxy" | undefined {
  return provider === "claudeAgent"
    ? providerOptions?.claudeAgent?.remote?.workspaceProxyMode
    : providerOptions?.codex?.remote?.workspaceProxyMode;
}

export function normalizeRemoteBridgeStartInput(
  input: ProviderSessionStartInput,
): ProviderSessionStartInput {
  const provider = input.provider ?? "codex";
  if (!input.providerOptions) {
    return input;
  }

  if (provider === "claudeAgent") {
    const workspaceProxyMode = input.providerOptions.claudeAgent?.remote?.workspaceProxyMode;
    return {
      ...input,
      providerOptions: {
        ...input.providerOptions,
        claudeAgent: {
          ...input.providerOptions.claudeAgent,
          executionMode: "local",
          remote:
            workspaceProxyMode !== undefined
              ? { workspaceProxyMode }
              : input.providerOptions.claudeAgent?.remote
                ? {}
                : undefined,
        },
      },
    };
  }

  const workspaceProxyMode = input.providerOptions.codex?.remote?.workspaceProxyMode;
  return {
    ...input,
    providerOptions: {
      ...input.providerOptions,
      codex: {
        ...input.providerOptions.codex,
        executionMode: "local",
        remote:
          workspaceProxyMode !== undefined
            ? { workspaceProxyMode }
            : input.providerOptions.codex?.remote
              ? {}
              : undefined,
      },
    },
  };
}
