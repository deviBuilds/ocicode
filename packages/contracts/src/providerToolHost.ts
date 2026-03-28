import { Schema } from "effect";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

export const PROVIDER_TOOL_HOST_WS_PATH = "/provider-tool-host";

export const ProviderToolHostToolName = Schema.Literals([
  "local_read_file",
  "local_list_directory",
  "local_glob_search",
  "local_grep_search",
  "local_write_file",
  "local_apply_patch",
  "local_exec_command",
  "local_read_image",
  "local_workspace_info",
]);
export type ProviderToolHostToolName = typeof ProviderToolHostToolName.Type;

export const ProviderToolReadFileArgs = Schema.Struct({
  path: TrimmedNonEmptyString,
  startLine: Schema.optional(NonNegativeInt),
  endLine: Schema.optional(NonNegativeInt),
  maxBytes: Schema.optional(NonNegativeInt),
});
export type ProviderToolReadFileArgs = typeof ProviderToolReadFileArgs.Type;

export const ProviderToolReadFileResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  content: Schema.String,
  startLine: NonNegativeInt,
  endLine: NonNegativeInt,
  totalLines: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ProviderToolReadFileResult = typeof ProviderToolReadFileResult.Type;

export const ProviderToolListDirectoryArgs = Schema.Struct({
  path: Schema.optional(TrimmedNonEmptyString),
  recursive: Schema.optional(Schema.Boolean),
  limit: Schema.optional(NonNegativeInt),
});
export type ProviderToolListDirectoryArgs = typeof ProviderToolListDirectoryArgs.Type;

export const ProviderToolListDirectoryEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  type: Schema.Literals(["file", "directory"]),
});
export type ProviderToolListDirectoryEntry = typeof ProviderToolListDirectoryEntry.Type;

export const ProviderToolListDirectoryResult = Schema.Struct({
  entries: Schema.Array(ProviderToolListDirectoryEntry),
  truncated: Schema.Boolean,
});
export type ProviderToolListDirectoryResult = typeof ProviderToolListDirectoryResult.Type;

export const ProviderToolGlobSearchArgs = Schema.Struct({
  pattern: TrimmedNonEmptyString,
  limit: Schema.optional(NonNegativeInt),
});
export type ProviderToolGlobSearchArgs = typeof ProviderToolGlobSearchArgs.Type;

export const ProviderToolGlobSearchResult = Schema.Struct({
  matches: Schema.Array(TrimmedNonEmptyString),
  truncated: Schema.Boolean,
});
export type ProviderToolGlobSearchResult = typeof ProviderToolGlobSearchResult.Type;

export const ProviderToolGrepSearchArgs = Schema.Struct({
  pattern: TrimmedNonEmptyString,
  glob: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(NonNegativeInt),
  caseSensitive: Schema.optional(Schema.Boolean),
});
export type ProviderToolGrepSearchArgs = typeof ProviderToolGrepSearchArgs.Type;

export const ProviderToolGrepMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineNumber: NonNegativeInt,
  line: Schema.String,
});
export type ProviderToolGrepMatch = typeof ProviderToolGrepMatch.Type;

export const ProviderToolGrepSearchResult = Schema.Struct({
  matches: Schema.Array(ProviderToolGrepMatch),
  truncated: Schema.Boolean,
});
export type ProviderToolGrepSearchResult = typeof ProviderToolGrepSearchResult.Type;

export const ProviderToolWriteFileArgs = Schema.Struct({
  path: TrimmedNonEmptyString,
  content: Schema.String,
});
export type ProviderToolWriteFileArgs = typeof ProviderToolWriteFileArgs.Type;

export const ProviderToolWriteFileResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  bytesWritten: NonNegativeInt,
});
export type ProviderToolWriteFileResult = typeof ProviderToolWriteFileResult.Type;

export const ProviderToolApplyPatchArgs = Schema.Struct({
  patch: Schema.String.check(Schema.isNonEmpty()),
});
export type ProviderToolApplyPatchArgs = typeof ProviderToolApplyPatchArgs.Type;

export const ProviderToolApplyPatchResult = Schema.Struct({
  applied: Schema.Boolean,
  stdout: Schema.String,
  stderr: Schema.String,
});
export type ProviderToolApplyPatchResult = typeof ProviderToolApplyPatchResult.Type;

export const ProviderToolExecCommandArgs = Schema.Struct({
  command: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
  timeoutMs: Schema.optional(NonNegativeInt),
});
export type ProviderToolExecCommandArgs = typeof ProviderToolExecCommandArgs.Type;

export const ProviderToolExecCommandResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  code: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
});
export type ProviderToolExecCommandResult = typeof ProviderToolExecCommandResult.Type;

export const ProviderToolReadImageArgs = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type ProviderToolReadImageArgs = typeof ProviderToolReadImageArgs.Type;

export const ProviderToolReadImageResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  mimeType: TrimmedNonEmptyString,
  base64: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
});
export type ProviderToolReadImageResult = typeof ProviderToolReadImageResult.Type;

export const ProviderToolWorkspaceInfoArgs = Schema.Struct({});
export type ProviderToolWorkspaceInfoArgs = typeof ProviderToolWorkspaceInfoArgs.Type;

export const ProviderToolWorkspaceInfoResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProviderToolWorkspaceInfoResult = typeof ProviderToolWorkspaceInfoResult.Type;

const ProviderToolHostRequestId = TrimmedNonEmptyString;
export type ProviderToolHostRequestId = typeof ProviderToolHostRequestId.Type;

export const ProviderToolHostRequest = Schema.Struct({
  id: ProviderToolHostRequestId,
  toolName: ProviderToolHostToolName,
  arguments: Schema.optional(Schema.Unknown),
});
export type ProviderToolHostRequest = typeof ProviderToolHostRequest.Type;

export const ProviderToolHostResponse = Schema.Struct({
  id: ProviderToolHostRequestId,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
    }),
  ),
});
export type ProviderToolHostResponse = typeof ProviderToolHostResponse.Type;

export const ProviderBridgeToolHostRequest = Schema.Struct({
  requestId: ProviderToolHostRequestId,
  threadId: ThreadId,
  toolName: ProviderToolHostToolName,
  arguments: Schema.optional(Schema.Unknown),
});
export type ProviderBridgeToolHostRequest = typeof ProviderBridgeToolHostRequest.Type;

export const ProviderBridgeResolveToolHostRequestInput = Schema.Struct({
  requestId: ProviderToolHostRequestId,
  threadId: ThreadId,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
    }),
  ),
});
export type ProviderBridgeResolveToolHostRequestInput =
  typeof ProviderBridgeResolveToolHostRequestInput.Type;
