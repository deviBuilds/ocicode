import { type ProviderBridgeHealthInput } from "@ocicode/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";

export const serverQueryKeys = {
  all: ["server"] as const,
  config: () => ["server", "config"] as const,
  providerHealth: (input: ProviderBridgeHealthInput) =>
    [
      "server",
      "providerHealth",
      input.provider ?? null,
      input.providerOptions?.codex?.executionMode ?? null,
      input.providerOptions?.codex?.binaryPath ?? null,
      input.providerOptions?.codex?.homePath ?? null,
      input.providerOptions?.codex?.remote?.baseUrl ?? null,
      input.providerOptions?.claudeAgent?.executionMode ?? null,
      input.providerOptions?.claudeAgent?.binaryPath ?? null,
      input.providerOptions?.claudeAgent?.remote?.baseUrl ?? null,
    ] as const,
};

export function serverConfigQueryOptions() {
  return queryOptions({
    queryKey: serverQueryKeys.config(),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.getConfig();
    },
    staleTime: Infinity,
  });
}

export function serverProviderHealthQueryOptions(
  input: ProviderBridgeHealthInput,
  options?: {
    enabled?: boolean;
  },
) {
  return queryOptions({
    queryKey: serverQueryKeys.providerHealth(input),
    queryFn: async () => {
      const api = ensureNativeApi();
      return api.server.checkProviderHealth(input);
    },
    enabled: options?.enabled ?? true,
    staleTime: 5_000,
  });
}
