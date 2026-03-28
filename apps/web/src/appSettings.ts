import { useCallback, useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import {
  type ProviderBridgeHealthInput,
  type ProviderExecutionMode,
  type ProviderKind,
  type ProviderStartOptions,
} from "@ocicode/contracts";
import { makeStorageKey } from "@ocicode/shared/branding";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@ocicode/shared/model";
import { TIMESTAMP_FORMAT_VALUES } from "./timestampFormat";

const APP_SETTINGS_STORAGE_KEY = makeStorageKey("app-settings:v1");
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

const AppSettingsSchema = Schema.Struct({
  codexMode: Schema.Literals(["disabled", "local", "remote"]).pipe(
    Schema.withConstructorDefault(() => Option.some("local")),
  ),
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  claudeMode: Schema.Literals(["disabled", "local", "remote"]).pipe(
    Schema.withConstructorDefault(() => Option.some("disabled")),
  ),
  claudeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  remoteBridgeUrl: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  remoteBridgeSharedSecret: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  defaultThreadEnvMode: Schema.Literals(["local", "worktree"]).pipe(
    Schema.withConstructorDefault(() => Option.some("local")),
  ),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  sidebarProjectSortOrder: Schema.Literals(SIDEBAR_PROJECT_SORT_ORDER_VALUES).pipe(
    Schema.withConstructorDefault(() => Option.some("updated_at")),
  ),
  sidebarThreadSortOrder: Schema.Literals(SIDEBAR_THREAD_SORT_ORDER_VALUES).pipe(
    Schema.withConstructorDefault(() => Option.some("updated_at")),
  ),
  timestampFormat: Schema.Literals(TIMESTAMP_FORMAT_VALUES).pipe(
    Schema.withConstructorDefault(() => Option.some("locale")),
  ),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  customClaudeModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});

let listeners: Array<() => void> = [];
let cachedRawSettings: string | null | undefined;
let cachedSnapshot: AppSettings = DEFAULT_APP_SETTINGS;

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

  if (provider === "codex") {
    const codexOptions = {
      executionMode,
      ...(settings.codexBinaryPath.trim().length > 0
        ? { binaryPath: settings.codexBinaryPath.trim() }
        : {}),
      ...(settings.codexHomePath.trim().length > 0
        ? { homePath: settings.codexHomePath.trim() }
        : {}),
      ...(remoteConfig ? { remote: remoteConfig } : {}),
    };
    return { codex: codexOptions };
  }

  const claudeOptions = {
    executionMode,
    ...(settings.claudeBinaryPath.trim().length > 0
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

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parsePersistedSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    return normalizeAppSettings(Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(value));
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (raw === cachedRawSettings) {
    return cachedSnapshot;
  }

  cachedRawSettings = raw;
  cachedSnapshot = parsePersistedSettings(raw);
  return cachedSnapshot;
}

function persistSettings(next: AppSettings): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  try {
    if (raw !== cachedRawSettings) {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, raw);
    }
  } catch {
    // Best-effort persistence only.
  }

  cachedRawSettings = raw;
  cachedSnapshot = next;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_SETTINGS_STORAGE_KEY) {
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getAppSettingsSnapshot,
    () => DEFAULT_APP_SETTINGS,
  );

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = normalizeAppSettings(
      Schema.decodeSync(AppSettingsSchema)({
        ...getAppSettingsSnapshot(),
        ...patch,
      }),
    );
    persistSettings(next);
    emitChange();
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_APP_SETTINGS);
    emitChange();
  }, []);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
