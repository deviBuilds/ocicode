import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { type ProviderKind } from "@ocicode/contracts";
import { getModelOptions, normalizeModelSlug } from "@ocicode/shared/model";

import {
  buildProviderHealthInput,
  getCustomModelsForProvider,
  getProviderExecutionMode,
  MAX_CUSTOM_MODEL_LENGTH,
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
  useAppSettings,
} from "../appSettings";
import { openInPreferredEditor } from "../editorPreferences";
import { isElectron } from "../env";
import { useColorTint, type ColorTint } from "../hooks/useColorTint";
import { useTheme } from "../hooks/useTheme";
import {
  serverConfigQueryOptions,
  serverProviderHealthQueryOptions,
} from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { type TimestampFormat } from "../timestampFormat";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { SidebarInset } from "~/components/ui/sidebar";
import { cn } from "~/lib/utils";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const TINT_OPTIONS: Array<{
  value: ColorTint;
  label: string;
  description: string;
}> = [
  {
    value: "neutral",
    label: "Neutral Charcoal",
    description: "Default dark appearance with no color bias, matching the main app shell.",
  },
  {
    value: "violet",
    label: "Blue / Violet",
    description: "Alternate dark appearance with a subtle blue-violet tint.",
  },
];

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  {
    provider: "claudeAgent",
    title: "Claude",
    description: "Save additional Claude model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-opus-5-preview",
  },
] as const;

const PROVIDER_EXECUTION_OPTIONS = [
  {
    value: "disabled",
    label: "Disabled",
    description: "Hide this provider from new chats and block new turns on existing threads.",
  },
  {
    value: "local",
    label: "Local",
    description: "Launch the provider CLI on this machine.",
  },
  {
    value: "remote",
    label: "Remote",
    description: "Connect to a remote provider bridge while keeping tools and files local.",
  },
] as const;

const TIMESTAMP_FORMAT_OPTIONS: ReadonlyArray<{
  value: TimestampFormat;
  label: string;
  description: string;
}> = [
  {
    value: "locale",
    label: "System locale",
    description: "Use your operating system's preferred time format.",
  },
  {
    value: "12-hour",
    label: "12-hour",
    description: "Show times like 3:42 PM.",
  },
  {
    value: "24-hour",
    label: "24-hour",
    description: "Show times like 15:42.",
  },
];

const DEFAULT_THREAD_ENV_MODE_OPTIONS = [
  {
    value: "local",
    label: "Local",
    description: "New draft threads start in the current workspace.",
  },
  {
    value: "worktree",
    label: "New worktree",
    description: "New draft threads default to creating a dedicated worktree.",
  },
] as const;

const SIDEBAR_PROJECT_SORT_OPTIONS: ReadonlyArray<{
  value: SidebarProjectSortOrder;
  label: string;
  description: string;
}> = [
  {
    value: "updated_at",
    label: "Recent activity",
    description: "Sort projects by the latest user message in each project.",
  },
  {
    value: "created_at",
    label: "Created at",
    description: "Keep newer projects near the top.",
  },
  {
    value: "manual",
    label: "Manual order",
    description: "Drag projects in the sidebar to reorder them.",
  },
];

const SIDEBAR_THREAD_SORT_OPTIONS: ReadonlyArray<{
  value: SidebarThreadSortOrder;
  label: string;
  description: string;
}> = [
  {
    value: "updated_at",
    label: "Recent activity",
    description: "Sort threads by the latest user message.",
  },
  {
    value: "created_at",
    label: "Created at",
    description: "Keep newer threads near the top.",
  },
];

function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
      return defaults.customCodexModels;
    case "claudeAgent":
      return defaults.customClaudeModels;
    default:
      return defaults.customCodexModels;
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "codex":
      return { customCodexModels: models };
    case "claudeAgent":
      return { customClaudeModels: models };
    default:
      return { customCodexModels: models };
  }
}

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { tint, setTint } = useColorTint();
  const { settings, defaults, updateSettings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const serverFeatureFlags = serverConfigQuery.data?.featureFlags ?? {
    claudeBuildEnabled: false,
    remoteProviderModeBuildEnabled: false,
  };
  const visibleProviders = MODEL_PROVIDER_SETTINGS.filter(
    (providerSettings) =>
      providerSettings.provider === "codex" ||
      (providerSettings.provider === "claudeAgent" && serverFeatureFlags.claudeBuildEnabled),
  );
  const codexHealthQuery = useQuery(
    serverProviderHealthQueryOptions(buildProviderHealthInput(settings, "codex")),
  );
  const claudeHealthQuery = useQuery(
    serverProviderHealthQueryOptions(buildProviderHealthInput(settings, "claudeAgent"), {
      enabled: serverFeatureFlags.claudeBuildEnabled,
    }),
  );
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeAgent: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});

  const codexBinaryPath = settings.codexBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const claudeBinaryPath = settings.claudeBinaryPath;
  const anyRemoteModeEnabled = visibleProviders.some(
    ({ provider }) => getProviderExecutionMode(settings, provider) === "remote",
  );
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    void openInPreferredEditor(api, keybindingsConfigPath)
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [keybindingsConfigPath]);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how OCI Code handles light and dark mode.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                {THEME_OPTIONS.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => setTheme(option.value)}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{option.label}</span>
                        <span className="text-xs">{option.description}</span>
                      </span>
                      {selected ? (
                        <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
              </p>

              <div className="mt-5 border-t border-border pt-5">
                <div className="mb-3">
                  <h3 className="text-xs font-medium text-foreground">Color Tint</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Choose the default dark shell look.
                  </p>
                </div>

                <div className="space-y-2" role="radiogroup" aria-label="Color tint preference">
                  {TINT_OPTIONS.map((option) => {
                    const selected = tint === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                          selected
                            ? "border-primary/60 bg-primary/8 text-foreground"
                            : "border-border bg-background text-muted-foreground hover:bg-accent"
                        }`}
                        onClick={() => setTint(option.value)}
                      >
                        <span className="flex flex-col">
                          <span className="text-sm font-medium">{option.label}</span>
                          <span className="text-xs">{option.description}</span>
                        </span>
                        {selected ? (
                          <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                            Selected
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Provider Execution</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose whether each provider is disabled, launched locally, or reached through a
                  remote bridge while the workspace stays on this device.
                </p>
              </div>

              <div className="space-y-5">
                {visibleProviders.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const mode = getProviderExecutionMode(settings, provider);
                  const healthQuery = provider === "codex" ? codexHealthQuery : claudeHealthQuery;
                  const healthStatus = healthQuery.data;

                  return (
                    <div
                      key={`provider-execution-${provider}`}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {provider === "codex"
                            ? "Codex can run locally or through the remote bridge."
                            : "Claude is build-gated and can be fully hidden or run through the remote bridge."}
                        </p>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-3">
                        {PROVIDER_EXECUTION_OPTIONS.map((option) => {
                          const selected = mode === option.value;
                          const remoteUnavailable =
                            option.value === "remote" &&
                            !serverFeatureFlags.remoteProviderModeBuildEnabled;
                          return (
                            <button
                              key={`${provider}:${option.value}`}
                              type="button"
                              disabled={remoteUnavailable}
                              className={cn(
                                "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55",
                                selected
                                  ? "border-primary/60 bg-primary/8 text-foreground"
                                  : "border-border bg-background text-muted-foreground hover:bg-accent",
                              )}
                              onClick={() =>
                                updateSettings(
                                  provider === "codex"
                                    ? { codexMode: option.value }
                                    : { claudeMode: option.value },
                                )
                              }
                            >
                              <span className="block text-sm font-medium text-inherit">
                                {option.label}
                              </span>
                              <span className="mt-1 block text-xs opacity-80">
                                {remoteUnavailable
                                  ? "Remote provider mode is not enabled in this build."
                                  : option.description}
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      <div className="mt-4 space-y-3">
                        {provider === "codex" ? (
                          <>
                            <label htmlFor="codex-binary-path" className="block space-y-1">
                              <span className="text-xs font-medium text-foreground">
                                Codex binary path
                              </span>
                              <Input
                                id="codex-binary-path"
                                value={codexBinaryPath}
                                onChange={(event) =>
                                  updateSettings({ codexBinaryPath: event.target.value })
                                }
                                placeholder="codex"
                                spellCheck={false}
                              />
                            </label>

                            <label htmlFor="codex-home-path" className="block space-y-1">
                              <span className="text-xs font-medium text-foreground">
                                CODEX_HOME path
                              </span>
                              <Input
                                id="codex-home-path"
                                value={codexHomePath}
                                onChange={(event) =>
                                  updateSettings({ codexHomePath: event.target.value })
                                }
                                placeholder="/Users/you/.codex"
                                spellCheck={false}
                              />
                            </label>
                          </>
                        ) : (
                          <label htmlFor="claude-binary-path" className="block space-y-1">
                            <span className="text-xs font-medium text-foreground">
                              Claude binary path
                            </span>
                            <Input
                              id="claude-binary-path"
                              value={claudeBinaryPath}
                              onChange={(event) =>
                                updateSettings({ claudeBinaryPath: event.target.value })
                              }
                              placeholder="claude"
                              spellCheck={false}
                            />
                          </label>
                        )}

                        <div className="rounded-lg border border-border bg-background px-3 py-2">
                          <p className="text-xs font-medium text-foreground">
                            Current status
                            {healthStatus?.executionMode ? ` · ${healthStatus.executionMode}` : ""}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {healthQuery.isFetching
                              ? "Checking provider status..."
                              : (healthStatus?.message ??
                                (healthStatus?.available
                                  ? "Provider is ready."
                                  : "Provider is unavailable."))}
                          </p>
                          <div className="mt-2 flex justify-end">
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={healthQuery.isFetching}
                              onClick={() => healthQuery.refetch()}
                            >
                              {healthQuery.isFetching ? "Testing..." : "Test connection"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}

                {serverFeatureFlags.remoteProviderModeBuildEnabled ? (
                  <div className="rounded-xl border border-border bg-background/50 p-4">
                    <div className="mb-4">
                      <h3 className="text-sm font-medium text-foreground">Remote bridge</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Shared remote bridge connection settings used by providers in remote mode.
                      </p>
                    </div>

                    <div className="space-y-4">
                      <label htmlFor="remote-bridge-url" className="block space-y-1">
                        <span className="text-xs font-medium text-foreground">Bridge base URL</span>
                        <Input
                          id="remote-bridge-url"
                          value={settings.remoteBridgeUrl}
                          onChange={(event) =>
                            updateSettings({ remoteBridgeUrl: event.target.value })
                          }
                          placeholder="ws://192.168.1.10:4321"
                          spellCheck={false}
                        />
                      </label>

                      <label htmlFor="remote-bridge-secret" className="block space-y-1">
                        <span className="text-xs font-medium text-foreground">Shared secret</span>
                        <Input
                          id="remote-bridge-secret"
                          value={settings.remoteBridgeSharedSecret}
                          onChange={(event) =>
                            updateSettings({ remoteBridgeSharedSecret: event.target.value })
                          }
                          placeholder="shared-secret"
                          spellCheck={false}
                          type="password"
                        />
                      </label>

                      {!anyRemoteModeEnabled ? (
                        <p className="text-xs text-muted-foreground">
                          Enable remote mode on at least one provider to use these settings.
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
                </p>
              </div>

              <div className="space-y-5">
                {visibleProviders.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const customModels = getCustomModelsForProvider(settings, provider);
                  const customModelInput = customModelInputByProvider[provider];
                  const customModelError = customModelErrorByProvider[provider] ?? null;
                  return (
                    <div
                      key={provider}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerSettings.description}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <label
                            htmlFor={`custom-model-slug-${provider}`}
                            className="block flex-1 space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Custom model slug
                            </span>
                            <Input
                              id={`custom-model-slug-${provider}`}
                              value={customModelInput}
                              onChange={(event) => {
                                const value = event.target.value;
                                setCustomModelInputByProvider((existing) => ({
                                  ...existing,
                                  [provider]: value,
                                }));
                                if (customModelError) {
                                  setCustomModelErrorByProvider((existing) => ({
                                    ...existing,
                                    [provider]: null,
                                  }));
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addCustomModel(provider);
                              }}
                              placeholder={providerSettings.placeholder}
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Example: <code>{providerSettings.example}</code>
                            </span>
                          </label>

                          <Button
                            className="sm:mt-6"
                            type="button"
                            onClick={() => addCustomModel(provider)}
                          >
                            Add model
                          </Button>
                        </div>

                        {customModelError ? (
                          <p className="text-xs text-destructive">{customModelError}</p>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>Saved custom models: {customModels.length}</p>
                            {customModels.length > 0 ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  updateSettings(
                                    patchCustomModels(provider, [
                                      ...getDefaultCustomModelsForProvider(defaults, provider),
                                    ]),
                                  )
                                }
                              >
                                Reset custom models
                              </Button>
                            ) : null}
                          </div>

                          {customModels.length > 0 ? (
                            <div className="space-y-2">
                              {customModels.map((slug) => (
                                <div
                                  key={`${provider}:${slug}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                >
                                  <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                    {slug}
                                  </code>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => removeCustomModel(provider, slug)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Responses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how assistant output is rendered during a turn.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
                  <p className="text-xs text-muted-foreground">
                    Show token-by-token output while a response is in progress.
                  </p>
                </div>
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableAssistantStreaming: Boolean(checked),
                    })
                  }
                  aria-label="Stream assistant messages"
                />
              </div>

              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: defaults.enableAssistantStreaming,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Conversation defaults</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Set the default environment mode and timestamp format for new threads.
                </p>
              </div>

              <div className="space-y-5">
                <div className="space-y-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Default new thread mode</p>
                    <p className="text-xs text-muted-foreground">
                      Controls whether draft threads start locally or in new-worktree mode.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {DEFAULT_THREAD_ENV_MODE_OPTIONS.map((option) => {
                      const selected = settings.defaultThreadEnvMode === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={cn(
                            "rounded-lg border px-3 py-2 text-left transition-colors",
                            selected
                              ? "border-primary/60 bg-primary/8 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:bg-accent",
                          )}
                          onClick={() => updateSettings({ defaultThreadEnvMode: option.value })}
                        >
                          <span className="block text-sm font-medium text-inherit">
                            {option.label}
                          </span>
                          <span className="mt-1 block text-xs opacity-80">
                            {option.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {settings.defaultThreadEnvMode !== defaults.defaultThreadEnvMode ? (
                    <div className="flex justify-end">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          updateSettings({
                            defaultThreadEnvMode: defaults.defaultThreadEnvMode,
                          })
                        }
                      >
                        Restore default
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Timestamp format</p>
                    <p className="text-xs text-muted-foreground">
                      Applies to message timestamps, plan timestamps, and diff history.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {TIMESTAMP_FORMAT_OPTIONS.map((option) => {
                      const selected = settings.timestampFormat === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={cn(
                            "rounded-lg border px-3 py-2 text-left transition-colors",
                            selected
                              ? "border-primary/60 bg-primary/8 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:bg-accent",
                          )}
                          onClick={() => updateSettings({ timestampFormat: option.value })}
                        >
                          <span className="block text-sm font-medium text-inherit">
                            {option.label}
                          </span>
                          <span className="mt-1 block text-xs opacity-80">
                            {option.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {settings.timestampFormat !== defaults.timestampFormat ? (
                    <div className="flex justify-end">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          updateSettings({
                            timestampFormat: defaults.timestampFormat,
                          })
                        }
                      >
                        Restore default
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Sidebar</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how projects and threads are ordered in the left sidebar.
                </p>
              </div>

              <div className="space-y-5">
                <div className="space-y-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Project ordering</p>
                    <p className="text-xs text-muted-foreground">
                      Manual order enables drag-and-drop reordering directly in the sidebar.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {SIDEBAR_PROJECT_SORT_OPTIONS.map((option) => {
                      const selected = settings.sidebarProjectSortOrder === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={cn(
                            "rounded-lg border px-3 py-2 text-left transition-colors",
                            selected
                              ? "border-primary/60 bg-primary/8 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:bg-accent",
                          )}
                          onClick={() =>
                            updateSettings({
                              sidebarProjectSortOrder: option.value,
                            })
                          }
                        >
                          <span className="block text-sm font-medium text-inherit">
                            {option.label}
                          </span>
                          <span className="mt-1 block text-xs opacity-80">
                            {option.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {settings.sidebarProjectSortOrder !== defaults.sidebarProjectSortOrder ? (
                    <div className="flex justify-end">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          updateSettings({
                            sidebarProjectSortOrder: defaults.sidebarProjectSortOrder,
                          })
                        }
                      >
                        Restore default
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <div>
                    <p className="text-sm font-medium text-foreground">Thread ordering</p>
                    <p className="text-xs text-muted-foreground">
                      Applies inside each project group in the sidebar.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {SIDEBAR_THREAD_SORT_OPTIONS.map((option) => {
                      const selected = settings.sidebarThreadSortOrder === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={cn(
                            "rounded-lg border px-3 py-2 text-left transition-colors",
                            selected
                              ? "border-primary/60 bg-primary/8 text-foreground"
                              : "border-border bg-background text-muted-foreground hover:bg-accent",
                          )}
                          onClick={() =>
                            updateSettings({
                              sidebarThreadSortOrder: option.value,
                            })
                          }
                        >
                          <span className="block text-sm font-medium text-inherit">
                            {option.label}
                          </span>
                          <span className="mt-1 block text-xs opacity-80">
                            {option.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {settings.sidebarThreadSortOrder !== defaults.sidebarThreadSortOrder ? (
                    <div className="flex justify-end">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          updateSettings({
                            sidebarThreadSortOrder: defaults.sidebarThreadSortOrder,
                          })
                        }
                      >
                        Restore default
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
