import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedString } from "./baseSchemas";

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const ProviderExecutionPreference = Schema.Literals(["disabled", "local", "remote"]);
export type ProviderExecutionPreference = typeof ProviderExecutionPreference.Type;

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(() => fallback),
  );

export const ClientSettingsSchema = Schema.Struct({
  codexMode: ProviderExecutionPreference.pipe(Schema.withDecodingDefault(() => "local")),
  claudeMode: ProviderExecutionPreference.pipe(Schema.withDecodingDefault(() => "local")),
  remoteBridgeUrl: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withDecodingDefault(() => ""),
  ),
  remoteBridgeSharedSecret: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withDecodingDefault(() => ""),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_PROJECT_SORT_ORDER),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(() => DEFAULT_SIDEBAR_THREAD_SORT_ORDER),
  ),
  timestampFormat: TimestampFormat.pipe(Schema.withDecodingDefault(() => DEFAULT_TIMESTAMP_FORMAT)),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;
export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

export const CodexServerSettings = Schema.Struct({
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(() => "")),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type CodexServerSettings = typeof CodexServerSettings.Type;

export const ClaudeServerSettings = Schema.Struct({
  binaryPath: makeBinaryPathSetting("claude"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
});
export type ClaudeServerSettings = typeof ClaudeServerSettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  defaultThreadEnvMode: ThreadEnvMode.pipe(Schema.withDecodingDefault(() => "local")),
  providers: Schema.Struct({
    codex: CodexServerSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    claudeAgent: ClaudeServerSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  }).pipe(Schema.withDecodingDefault(() => ({}))),
});
export type ServerSettings = typeof ServerSettings.Type;
export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export type UnifiedSettings = ClientSettings & ServerSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optional(Schema.Boolean),
  defaultThreadEnvMode: Schema.optional(ThreadEnvMode),
  providers: Schema.optional(
    Schema.Struct({
      codex: Schema.optional(
        Schema.Struct({
          binaryPath: Schema.optional(Schema.String),
          homePath: Schema.optional(Schema.String),
          customModels: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
      claudeAgent: Schema.optional(
        Schema.Struct({
          binaryPath: Schema.optional(Schema.String),
          customModels: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;
