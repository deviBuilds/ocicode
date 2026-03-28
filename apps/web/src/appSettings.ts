import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Predicate } from "effect";
import {
  type ClientSettings,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  type ProviderBridgeHealthInput,
  type ProviderExecutionMode,
  type ProviderKind,
  type ProviderStartOptions,
  type ServerConfig,
  type ServerSettingsPatch,
} from "@ocicode/contracts";
import { makeStorageKey } from "@ocicode/shared/branding";
import { deepMerge } from "@ocicode/shared/Struct";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@ocicode/shared/model";
import { ensureNativeApi } from "./nativeApi";
import { serverConfigQueryOptions, serverQueryKeys } from "./lib/serverReactQuery";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = makeStorageKey("client-settings:v1");
const LEGACY_SETTINGS_STORAGE_KEY = makeStorageKey("app-settings:v1");
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export type DefaultThreadEnvMode = "local" | "worktree";
export const SIDEBAR_PROJECT_SORT_ORDER_VALUES = ["updated_at", "created_at", "manual"] as const;
export type SidebarProjectSortOrder = (typeof SIDEBAR_PROJECT_SORT_ORDER_VALUES)[number];
export const SIDEBAR_THREAD_SORT_ORDER_VALUES = ["updated_at", "created_at"] as const;
export type SidebarThreadSortOrder = (typeof SIDEBAR_THREAD_SORT_ORDER_VALUES)[number];
const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  claudeAgent: new Set(getModelOptions("claudeAgent").map((option) => option.slug)),
};

export type AppSettings = ClientSettings & {
  readonly codexBinaryPath: string;
  readonly codexHomePath: string;
  readonly claudeBinaryPath: string;
  readonly defaultThreadEnvMode: DefaultThreadEnvMode;
  readonly enableAssistantStreaming: boolean;
  readonly customCodexModels: readonly string[];
  readonly customClaudeModels: readonly string[];
};

export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? U[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

type MutableServerProvidersPatch = {
  codex?: {
    binaryPath?: string;
    homePath?: string;
    customModels?: string[];
  };
  claudeAgent?: {
    binaryPath?: string;
    customModels?: string[];
  };
};

function flattenAppSettings(
  serverSettings = DEFAULT_SERVER_SETTINGS,
  clientSettings = DEFAULT_CLIENT_SETTINGS,
): AppSettings {
  return normalizeAppSettings({
    ...clientSettings,
    codexBinaryPath: serverSettings.providers.codex.binaryPath,
    codexHomePath: serverSettings.providers.codex.homePath,
    claudeBinaryPath: serverSettings.providers.claudeAgent.binaryPath,
    defaultThreadEnvMode: serverSettings.defaultThreadEnvMode,
    enableAssistantStreaming: serverSettings.enableAssistantStreaming,
    customCodexModels: serverSettings.providers.codex.customModels,
    customClaudeModels: serverSettings.providers.claudeAgent.customModels,
  });
}

const DEFAULT_APP_SETTINGS: AppSettings = flattenAppSettings();

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
    customClaudeModels: normalizeCustomModelSlugs(settings.customClaudeModels, "claudeAgent"),
  };
}

function buildServerSettingsPatch(patch: Partial<AppSettings>): ServerSettingsPatch {
  const next: Mutable<ServerSettingsPatch> = {};

  if (Object.prototype.hasOwnProperty.call(patch, "enableAssistantStreaming")) {
    next.enableAssistantStreaming = Boolean(patch.enableAssistantStreaming);
  }

  if (patch.defaultThreadEnvMode === "local" || patch.defaultThreadEnvMode === "worktree") {
    next.defaultThreadEnvMode = patch.defaultThreadEnvMode;
  }

  const providers: MutableServerProvidersPatch = {};
  let hasProvidersPatch = false;

  if (Object.prototype.hasOwnProperty.call(patch, "codexBinaryPath")) {
    providers.codex ??= {};
    providers.codex.binaryPath = patch.codexBinaryPath ?? "";
    hasProvidersPatch = true;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "codexHomePath")) {
    providers.codex ??= {};
    providers.codex.homePath = patch.codexHomePath ?? "";
    hasProvidersPatch = true;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "customCodexModels")) {
    providers.codex ??= {};
    providers.codex.customModels = normalizeCustomModelSlugs(
      patch.customCodexModels ?? [],
      "codex",
    );
    hasProvidersPatch = true;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "claudeBinaryPath")) {
    providers.claudeAgent ??= {};
    providers.claudeAgent.binaryPath = patch.claudeBinaryPath ?? "";
    hasProvidersPatch = true;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "customClaudeModels")) {
    providers.claudeAgent ??= {};
    providers.claudeAgent.customModels = normalizeCustomModelSlugs(
      patch.customClaudeModels ?? [],
      "claudeAgent",
    );
    hasProvidersPatch = true;
  }

  if (hasProvidersPatch) {
    next.providers = providers as ServerSettingsPatch["providers"];
  }

  return next as ServerSettingsPatch;
}

function buildClientSettingsPatch(patch: Partial<AppSettings>): Partial<ClientSettings> {
  const next: Mutable<Partial<ClientSettings>> = {};

  if (patch.codexMode !== undefined) {
    next.codexMode = patch.codexMode;
  }
  if (patch.claudeMode !== undefined) {
    next.claudeMode = patch.claudeMode;
  }
  if (patch.remoteBridgeUrl !== undefined) {
    next.remoteBridgeUrl = patch.remoteBridgeUrl;
  }
  if (patch.remoteBridgeSharedSecret !== undefined) {
    next.remoteBridgeSharedSecret = patch.remoteBridgeSharedSecret;
  }
  if (patch.confirmThreadDelete !== undefined) {
    next.confirmThreadDelete = patch.confirmThreadDelete;
  }
  if (patch.sidebarProjectSortOrder !== undefined) {
    next.sidebarProjectSortOrder = patch.sidebarProjectSortOrder;
  }
  if (patch.sidebarThreadSortOrder !== undefined) {
    next.sidebarThreadSortOrder = patch.sidebarThreadSortOrder;
  }
  if (patch.timestampFormat !== undefined) {
    next.timestampFormat = patch.timestampFormat;
  }

  return next as Partial<ClientSettings>;
}

function hasPatchEntries(patch: object): boolean {
  return Object.keys(patch).length > 0;
}

function readClientSettingsSnapshot(): ClientSettings {
  return (
    getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema) ??
    DEFAULT_CLIENT_SETTINGS
  );
}

export function getProviderExecutionMode(
  settings: Pick<AppSettings, "codexMode" | "claudeMode">,
  provider: ProviderKind,
): ProviderExecutionMode {
  return provider === "codex" ? settings.codexMode : settings.claudeMode;
}

export function getCustomModelsForProvider(
  settings: Pick<AppSettings, "customCodexModels" | "customClaudeModels">,
  provider: ProviderKind,
): readonly string[] {
  return provider === "codex" ? settings.customCodexModels : settings.customClaudeModels;
}

export function buildProviderStartOptionsForProvider(
  settings: Pick<
    AppSettings,
    | "codexMode"
    | "codexBinaryPath"
    | "codexHomePath"
    | "claudeMode"
    | "claudeBinaryPath"
    | "remoteBridgeUrl"
    | "remoteBridgeSharedSecret"
  >,
  provider: ProviderKind,
): ProviderStartOptions | undefined {
  const executionMode = getProviderExecutionMode(settings, provider);
  const remoteConfig =
    executionMode === "remote" ||
    settings.remoteBridgeUrl.trim().length > 0 ||
    settings.remoteBridgeSharedSecret.trim().length > 0
      ? {
          ...(settings.remoteBridgeUrl.trim().length > 0
            ? { baseUrl: settings.remoteBridgeUrl.trim() }
            : {}),
          ...(settings.remoteBridgeSharedSecret.trim().length > 0
            ? { sharedSecret: settings.remoteBridgeSharedSecret.trim() }
            : {}),
          workspaceProxyMode: "local-proxy" as const,
        }
      : undefined;
  const includeLocalBinaryOverrides = executionMode !== "remote";

  if (provider === "codex") {
    const codexOptions = {
      executionMode,
      ...(includeLocalBinaryOverrides && settings.codexBinaryPath.trim().length > 0
        ? { binaryPath: settings.codexBinaryPath.trim() }
        : {}),
      ...(includeLocalBinaryOverrides && settings.codexHomePath.trim().length > 0
        ? { homePath: settings.codexHomePath.trim() }
        : {}),
      ...(remoteConfig ? { remote: remoteConfig } : {}),
    };
    return { codex: codexOptions };
  }

  const claudeOptions = {
    executionMode,
    ...(includeLocalBinaryOverrides && settings.claudeBinaryPath.trim().length > 0
      ? { binaryPath: settings.claudeBinaryPath.trim() }
      : {}),
    ...(remoteConfig ? { remote: remoteConfig } : {}),
  };
  return { claudeAgent: claudeOptions };
}

export function buildProviderHealthInput(
  settings: Pick<
    AppSettings,
    | "codexMode"
    | "codexBinaryPath"
    | "codexHomePath"
    | "claudeMode"
    | "claudeBinaryPath"
    | "remoteBridgeUrl"
    | "remoteBridgeSharedSecret"
  >,
  provider: ProviderKind,
): ProviderBridgeHealthInput {
  return {
    provider,
    providerOptions: buildProviderStartOptionsForProvider(settings, provider),
  };
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function getSlashModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  query: string,
  selectedModel?: string | null,
): AppModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const options = getAppModelOptions(provider, customModels, selectedModel);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchSlug = option.slug.toLowerCase();
    const searchName = option.name.toLowerCase();
    return searchSlug.includes(normalizedQuery) || searchName.includes(normalizedQuery);
  });
}

function buildLegacyServerSettingsMigrationPatch(
  legacySettings: Record<string, unknown>,
): ServerSettingsPatch {
  const patch: Mutable<ServerSettingsPatch> = {};
  const providers: MutableServerProvidersPatch = {};
  let hasProvidersPatch = false;

  if (Predicate.isBoolean(legacySettings.enableAssistantStreaming)) {
    patch.enableAssistantStreaming = legacySettings.enableAssistantStreaming;
  }

  if (
    legacySettings.defaultThreadEnvMode === "local" ||
    legacySettings.defaultThreadEnvMode === "worktree"
  ) {
    patch.defaultThreadEnvMode = legacySettings.defaultThreadEnvMode;
  }

  if (typeof legacySettings.codexBinaryPath === "string") {
    providers.codex ??= {};
    providers.codex.binaryPath = legacySettings.codexBinaryPath;
    hasProvidersPatch = true;
  }

  if (typeof legacySettings.codexHomePath === "string") {
    providers.codex ??= {};
    providers.codex.homePath = legacySettings.codexHomePath;
    hasProvidersPatch = true;
  }

  if (Array.isArray(legacySettings.customCodexModels)) {
    providers.codex ??= {};
    providers.codex.customModels = normalizeCustomModelSlugs(
      legacySettings.customCodexModels,
      "codex",
    );
    hasProvidersPatch = true;
  }

  if (typeof legacySettings.claudeBinaryPath === "string") {
    providers.claudeAgent ??= {};
    providers.claudeAgent.binaryPath = legacySettings.claudeBinaryPath;
    hasProvidersPatch = true;
  }

  if (Array.isArray(legacySettings.customClaudeModels)) {
    providers.claudeAgent ??= {};
    providers.claudeAgent.customModels = normalizeCustomModelSlugs(
      legacySettings.customClaudeModels,
      "claudeAgent",
    );
    hasProvidersPatch = true;
  }

  if (hasProvidersPatch) {
    patch.providers = providers as ServerSettingsPatch["providers"];
  }

  return patch as ServerSettingsPatch;
}

function buildLegacyClientSettingsMigrationPatch(
  legacySettings: Record<string, unknown>,
): Partial<ClientSettings> {
  const patch: Mutable<Partial<ClientSettings>> = {};

  if (
    legacySettings.codexMode === "disabled" ||
    legacySettings.codexMode === "local" ||
    legacySettings.codexMode === "remote"
  ) {
    patch.codexMode = legacySettings.codexMode;
  }

  if (
    legacySettings.claudeMode === "disabled" ||
    legacySettings.claudeMode === "local" ||
    legacySettings.claudeMode === "remote"
  ) {
    patch.claudeMode = legacySettings.claudeMode;
  }

  if (typeof legacySettings.remoteBridgeUrl === "string") {
    patch.remoteBridgeUrl = legacySettings.remoteBridgeUrl;
  }

  if (typeof legacySettings.remoteBridgeSharedSecret === "string") {
    patch.remoteBridgeSharedSecret = legacySettings.remoteBridgeSharedSecret;
  }

  if (Predicate.isBoolean(legacySettings.confirmThreadDelete)) {
    patch.confirmThreadDelete = legacySettings.confirmThreadDelete;
  }

  if (
    legacySettings.sidebarProjectSortOrder === "updated_at" ||
    legacySettings.sidebarProjectSortOrder === "created_at" ||
    legacySettings.sidebarProjectSortOrder === "manual"
  ) {
    patch.sidebarProjectSortOrder = legacySettings.sidebarProjectSortOrder;
  }

  if (
    legacySettings.sidebarThreadSortOrder === "updated_at" ||
    legacySettings.sidebarThreadSortOrder === "created_at"
  ) {
    patch.sidebarThreadSortOrder = legacySettings.sidebarThreadSortOrder;
  }

  if (
    legacySettings.timestampFormat === "locale" ||
    legacySettings.timestampFormat === "12-hour" ||
    legacySettings.timestampFormat === "24-hour"
  ) {
    patch.timestampFormat = legacySettings.timestampFormat;
  }

  return patch as Partial<ClientSettings>;
}

export function migrateLocalSettingsToServer(): void {
  if (typeof window === "undefined") {
    return;
  }

  const raw = window.localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Predicate.isObject(parsed)) {
      return;
    }

    const serverPatch = buildLegacyServerSettingsMigrationPatch(parsed);
    if (hasPatchEntries(serverPatch)) {
      void ensureNativeApi().server.updateSettings(serverPatch);
    }

    const clientPatch = buildLegacyClientSettingsMigrationPatch(parsed);
    if (hasPatchEntries(clientPatch)) {
      setLocalStorageItem(
        CLIENT_SETTINGS_STORAGE_KEY,
        {
          ...readClientSettingsSnapshot(),
          ...clientPatch,
        },
        ClientSettingsSchema,
      );
    }
  } catch (error) {
    console.error("[SETTINGS] Failed to migrate legacy settings", error);
  } finally {
    window.localStorage.removeItem(LEGACY_SETTINGS_STORAGE_KEY);
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  return flattenAppSettings(DEFAULT_SERVER_SETTINGS, readClientSettingsSnapshot());
}

export function useAppSettings() {
  const queryClient = useQueryClient();
  const { data: serverConfig } = useQuery(serverConfigQueryOptions());
  const [clientSettings, setClientSettings] = useLocalStorage(
    CLIENT_SETTINGS_STORAGE_KEY,
    DEFAULT_CLIENT_SETTINGS,
    ClientSettingsSchema,
  );

  const settings = useMemo(
    () => flattenAppSettings(serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS, clientSettings),
    [clientSettings, serverConfig?.settings],
  );

  const updateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      const serverPatch = buildServerSettingsPatch(patch);
      const clientPatch = buildClientSettingsPatch(patch);

      if (hasPatchEntries(clientPatch)) {
        setClientSettings((previous) => ({
          ...previous,
          ...clientPatch,
        }));
      }

      if (hasPatchEntries(serverPatch)) {
        queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) =>
          current
            ? {
                ...current,
                settings: deepMerge(current.settings, serverPatch as never),
              }
            : current,
        );

        void ensureNativeApi()
          .server.updateSettings(serverPatch)
          .catch(() => {
            void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
          });
      }
    },
    [queryClient, setClientSettings],
  );

  const resetSettings = useCallback(() => {
    updateSettings(DEFAULT_APP_SETTINGS);
  }, [updateSettings]);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
