import crypto from "node:crypto";

import {
  query,
  type CanUseTool,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type Query as ClaudeQuery,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeContentStreamKind,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@ocicode/contracts";
import { getDefaultModel, normalizeModelSlug } from "@ocicode/shared/model";
import { normalizeRemoteBridgeStartInput } from "@ocicode/shared/provider";
import { Cause, Effect, FileSystem, Fiber, Layer, Queue, Schema, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ProviderToolHost } from "../Services/ProviderToolHost.ts";
import { type ClaudeAdapterShape, ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import {
  buildClaudePromptText,
  CLAUDE_CONTEXT_1M_BETA,
  getClaudeModelCapabilities,
  normalizeClaudeModelOptions,
  SUPPORTED_CLAUDE_IMAGE_MIME_TYPES,
} from "../claudeSupport.ts";
import {
  getRemoteProviderBridgeClient,
  remoteProviderBridgeReadThread,
  remoteProviderBridgeSendTurn,
  remoteProviderBridgeStartSession,
} from "../remoteBridgeClient";
import { buildWorkspaceProxyProcessConfig, buildWorkspaceProxyUrl } from "../workspaceProxy.ts";

const PROVIDER = "claudeAgent" as const;
const DEFAULT_MODEL = getDefaultModel(PROVIDER);
const CLAUDE_SETTING_SOURCES = ["user", "project", "local"] as const;
const WORKSPACE_PROXY_SYSTEM_PROMPT = [
  "Remote provider mode is active.",
  "Use the local workspace MCP tools for reading files, editing files, and running commands.",
  "Do not rely on native filesystem or shell access on this machine.",
].join(" ");

type RemoteBridgeConfig = {
  readonly baseUrl: string;
  readonly sharedSecret: string;
};

type WorkspaceProxyConfig = {
  readonly mode: "local-proxy";
  readonly token: string;
  readonly url: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
};

type ClaudeResumeState = {
  readonly resume?: string;
  readonly resumeSessionAt?: string;
};

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

type AssistantTextBlockState = {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
};

type PendingApproval = {
  readonly requestId: ApprovalRequestId;
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
};

type PendingUserInput = {
  readonly requestId: ApprovalRequestId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly resolve: (answers: ProviderUserInputAnswers) => void;
};

type ClaudeTurnSnapshot = {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  assistantUuid?: string;
};

type ClaudeTurnState = {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  nextSyntheticAssistantBlockIndex: number;
  assistantUuid?: string;
};

type ToolInFlight = {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
};

type ClaudeSessionContext = {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQuery;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  currentModel: string | undefined;
  readonly turns: Array<ClaudeTurnSnapshot>;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: Record<string, unknown> | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  resumeSessionId: string | undefined;
  resumeSessionAt: string | undefined;
  workspaceProxy: WorkspaceProxyConfig | undefined;
  binaryPath: string | undefined;
  stopped: boolean;
};

export interface ClaudeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQuery;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function readExecutionMode(input: {
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
}) {
  return input.providerOptions?.claudeAgent?.executionMode ?? "local";
}

function readWorkspaceProxyMode(input: {
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
}): "local-proxy" | undefined {
  return input.providerOptions?.claudeAgent?.remote?.workspaceProxyMode;
}

function readClaudeBinaryPath(input: {
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
}): string | undefined {
  const candidate = input.providerOptions?.claudeAgent?.binaryPath?.trim();
  return candidate && candidate.length > 0 ? candidate : undefined;
}

function readRemoteBridgeConfig(input: {
  readonly providerOptions?: ProviderSessionStartInput["providerOptions"];
}): RemoteBridgeConfig | undefined {
  const baseUrl = input.providerOptions?.claudeAgent?.remote?.baseUrl?.trim();
  const sharedSecret = input.providerOptions?.claudeAgent?.remote?.sharedSecret?.trim();
  if (!baseUrl || !sharedSecret) {
    return undefined;
  }
  return { baseUrl, sharedSecret };
}

function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

function readResumeState(resumeCursor: unknown): ClaudeResumeState {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return {};
  }
  const cursor = resumeCursor as {
    resume?: unknown;
    resumeSessionAt?: unknown;
  };
  return {
    ...(typeof cursor.resume === "string" ? { resume: cursor.resume } : {}),
    ...(typeof cursor.resumeSessionAt === "string"
      ? { resumeSessionAt: cursor.resumeSessionAt }
      : {}),
  };
}

function normalizedClaudeModel(model: string | undefined): string {
  return normalizeModelSlug(model, PROVIDER) ?? DEFAULT_MODEL;
}

function providerEventBase(context: ClaudeSessionContext, input?: { turnId?: TurnId }) {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    provider: PROVIDER,
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
    ...(input?.turnId ? { turnId: input.turnId } : {}),
  } as const;
}

function updateResumeCursor(context: ClaudeSessionContext): void {
  context.session = {
    ...context.session,
    resumeCursor: {
      threadId: context.session.threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
      turnCount: context.turns.length,
    },
    updatedAt: new Date().toISOString(),
  };
}

function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function maxClaudeContextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  if (!modelUsage || typeof modelUsage !== "object") {
    return undefined;
  }

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const contextWindow = (value as { contextWindow?: unknown }).contextWindow;
    if (
      typeof contextWindow !== "number" ||
      !Number.isFinite(contextWindow) ||
      contextWindow <= 0
    ) {
      continue;
    }
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

function normalizeClaudeTokenUsage(
  usage: unknown,
  contextWindow?: number,
): Record<string, unknown> | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;
  const directUsedTokens =
    typeof record.total_tokens === "number" && Number.isFinite(record.total_tokens)
      ? record.total_tokens
      : undefined;
  const inputTokens =
    (typeof record.input_tokens === "number" && Number.isFinite(record.input_tokens)
      ? record.input_tokens
      : 0) +
    (typeof record.cache_creation_input_tokens === "number" &&
    Number.isFinite(record.cache_creation_input_tokens)
      ? record.cache_creation_input_tokens
      : 0) +
    (typeof record.cache_read_input_tokens === "number" &&
    Number.isFinite(record.cache_read_input_tokens)
      ? record.cache_read_input_tokens
      : 0);
  const outputTokens =
    typeof record.output_tokens === "number" && Number.isFinite(record.output_tokens)
      ? record.output_tokens
      : 0;
  const derivedUsedTokens = inputTokens + outputTokens;
  const usedTokens = directUsedTokens ?? (derivedUsedTokens > 0 ? derivedUsedTokens : undefined);
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? { maxTokens: contextWindow }
      : {}),
    ...(typeof record.tool_uses === "number" && Number.isFinite(record.tool_uses)
      ? { toolUses: record.tool_uses }
      : {}),
    ...(typeof record.duration_ms === "number" && Number.isFinite(record.duration_ms)
      ? { durationMs: record.duration_ms }
      : {}),
  };
}

function isAskUserQuestionTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return (
    normalized === "askuserquestion" ||
    normalized === "ask_user_question" ||
    normalized.includes("askuserquestion")
  );
}

function resultErrorMessage(result: SDKResultMessage): string | undefined {
  if (result.subtype === "success") {
    return undefined;
  }
  const message = result.errors.join(" ").trim();
  return message.length > 0 ? message : undefined;
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("agent") ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search") ||
    normalized.includes("ls")
  );
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

function parseClaudeUserInputQuestions(
  toolInput: Record<string, unknown>,
): Array<UserInputQuestion> {
  const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
  const parsedQuestions: Array<UserInputQuestion> = [];

  for (const [index, entry] of rawQuestions.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const question = entry as Record<string, unknown>;
    const id = typeof question.id === "string" ? question.id.trim() : "";
    const header = typeof question.header === "string" ? question.header.trim() : "";
    const prompt = typeof question.question === "string" ? question.question.trim() : "";
    const options: Array<{ label: string; description: string }> = [];

    if (Array.isArray(question.options)) {
      for (const option of question.options) {
        if (!option || typeof option !== "object" || Array.isArray(option)) {
          continue;
        }

        const record = option as Record<string, unknown>;
        const label = typeof record.label === "string" ? record.label.trim() : "";
        const description = typeof record.description === "string" ? record.description.trim() : "";
        if (!label || !description) {
          continue;
        }
        options.push({ label, description });
      }
    }

    if (!prompt || options.length === 0) {
      continue;
    }

    parsedQuestions.push({
      id: id || `question-${index + 1}`,
      header: header || `Question ${index + 1}`,
      question: prompt,
      options,
    });
  }

  return parsedQuestions;
}

function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.makeUnsafe(options.providerItemId),
    };
  }
  return {};
}

function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

function toolResultStreamKind(itemType: CanonicalItemType): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

function requireLocalSession(
  localSessions: Map<ThreadId, ClaudeSessionContext>,
  threadId: ThreadId,
): ClaudeSessionContext | ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError {
  const context = localSessions.get(threadId);
  if (!context) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (context.stopped || context.session.status === "closed") {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return context;
}

function requireLocalSessionEffect(
  localSessions: Map<ThreadId, ClaudeSessionContext>,
  threadId: ThreadId,
): Effect.Effect<
  ClaudeSessionContext,
  ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError
> {
  const context = requireLocalSession(localSessions, threadId);
  if (Schema.is(ProviderAdapterSessionNotFoundError)(context)) {
    return Effect.fail(context);
  }
  if (Schema.is(ProviderAdapterSessionClosedError)(context)) {
    return Effect.fail(context);
  }
  return Effect.succeed(context);
}

function emitRuntimeEvent(
  runtimeEventQueue: Queue.Queue<ProviderRuntimeEvent>,
  event: ProviderRuntimeEvent,
): void {
  void Effect.runPromise(Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid));
}

function buildWorkspaceProxyConfig(input: {
  readonly serverPort: number;
  readonly token: string;
}): WorkspaceProxyConfig {
  const url = buildWorkspaceProxyUrl(input.serverPort, input.token);
  const processConfig = buildWorkspaceProxyProcessConfig(url);
  return {
    mode: "local-proxy",
    token: input.token,
    url,
    command: processConfig.command,
    args: processConfig.args,
  };
}

function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

function buildPromptSummary(input: {
  readonly promptText: string;
  readonly attachmentCount: number;
}): string {
  if (input.promptText.length > 0) {
    return input.promptText;
  }
  if (input.attachmentCount === 1) {
    return "[1 image attachment]";
  }
  return `[${input.attachmentCount} image attachments]`;
}

const buildUserMessageEffect = Effect.fn(function* (
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly stateDir: string;
  },
) {
  const promptText = buildClaudePromptText({
    text: input.input?.trim() ?? "",
    model: input.model,
    modelOptions: input.modelOptions?.claudeAgent,
  });
  const sdkContent: Array<Record<string, unknown>> = [];

  if (promptText.length > 0) {
    sdkContent.push({ type: "text", text: promptText });
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }

    if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
      });
    }

    const attachmentPath = resolveAttachmentPath({
      stateDir: dependencies.stateDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: toMessage(cause, "Failed to read Claude image attachment."),
            cause,
          }),
      ),
    );

    sdkContent.push(
      buildClaudeImageContentBlock({
        mimeType: attachment.mimeType,
        bytes,
      }),
    );
  }

  if (sdkContent.length === 0) {
    return yield* new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation: "sendTurn",
      issue: "Claude turns require a non-empty input message or at least one image attachment.",
    });
  }

  const promptSummary = buildPromptSummary({
    promptText,
    attachmentCount: (input.attachments ?? []).length,
  });

  const promptMessage = {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: sdkContent,
    },
  } as unknown as SDKUserMessage;

  return {
    promptSummary,
    promptMessage,
  };
});

function buildClaudeQueryOptions(input: {
  readonly context: ClaudeSessionContext;
  readonly model: string;
  readonly modelOptions?: ProviderSendTurnInput["modelOptions"];
  readonly binaryPath?: string;
  readonly canUseTool?: CanUseTool;
  readonly interactionMode?: "default" | "plan";
}): ClaudeQueryOptions {
  const usesWorkspaceProxy = input.context.workspaceProxy !== undefined;
  const permissionMode =
    input.interactionMode === "plan"
      ? "plan"
      : !usesWorkspaceProxy && input.context.session.runtimeMode === "full-access"
        ? "bypassPermissions"
        : undefined;
  const normalizedModelOptions = normalizeClaudeModelOptions(
    input.model,
    input.modelOptions?.claudeAgent,
  );
  const caps = getClaudeModelCapabilities(input.model);
  const resolvedEffort = normalizedModelOptions?.effort;
  const apiEffort =
    resolvedEffort && !caps.promptInjectedEffortLevels.includes(resolvedEffort)
      ? (resolvedEffort as Exclude<typeof resolvedEffort, "ultrathink">)
      : undefined;

  return {
    model: input.model,
    ...(input.context.session.cwd ? { cwd: input.context.session.cwd } : {}),
    ...(input.binaryPath ? { pathToClaudeCodeExecutable: input.binaryPath } : {}),
    settingSources: [...CLAUDE_SETTING_SOURCES],
    ...(permissionMode ? { permissionMode } : {}),
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(input.context.resumeSessionId ? { resume: input.context.resumeSessionId } : {}),
    ...(input.context.resumeSessionAt ? { resumeSessionAt: input.context.resumeSessionAt } : {}),
    ...(input.canUseTool ? { canUseTool: input.canUseTool } : {}),
    includePartialMessages: true,
    env: process.env,
    ...(input.context.session.cwd ? { additionalDirectories: [input.context.session.cwd] } : {}),
    ...(normalizedModelOptions?.thinking === false
      ? { thinking: { type: "disabled" as const } }
      : {}),
    ...(apiEffort ? { effort: apiEffort } : {}),
    ...(normalizedModelOptions?.contextWindow === "1m" ? { betas: [CLAUDE_CONTEXT_1M_BETA] } : {}),
    ...(input.context.workspaceProxy
      ? {
          tools: [],
          strictMcpConfig: true,
          mcpServers: {
            ocicode_local_workspace: {
              command: input.context.workspaceProxy.command,
              args: [...input.context.workspaceProxy.args],
            },
          },
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: WORKSPACE_PROXY_SYSTEM_PROMPT,
          },
        }
      : {
          tools: {
            type: "preset" as const,
            preset: "claude_code" as const,
          },
        }),
  };
}

function buildCanUseTool(input: {
  readonly getContext: () => ClaudeSessionContext | undefined;
  readonly runtimeEventQueue: Queue.Queue<ProviderRuntimeEvent>;
  readonly onExitPlanMode?: (input: {
    readonly context: ClaudeSessionContext;
    readonly planMarkdown: string;
    readonly toolUseId?: string | undefined;
    readonly rawPayload?: unknown;
  }) => void;
}): CanUseTool {
  return async (toolName, toolInput, callbackOptions) => {
    const context = input.getContext();
    if (!context) {
      return {
        behavior: "deny",
        message: "Claude session context is unavailable.",
      } satisfies PermissionResult;
    }
    const turnId = context.turnState?.turnId;
    const providerItemId =
      callbackOptions &&
      "toolUseID" in callbackOptions &&
      typeof callbackOptions.toolUseID === "string"
        ? callbackOptions.toolUseID
        : undefined;
    if (isAskUserQuestionTool(toolName)) {
      const questions = parseClaudeUserInputQuestions(toolInput);
      if (questions.length === 0) {
        return {
          behavior: "deny",
          message: "Claude requested user input with no valid questions.",
        } satisfies PermissionResult;
      }

      const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
      const answers = new Promise<ProviderUserInputAnswers>((resolve) => {
        context.pendingUserInputs.set(requestId, {
          requestId,
          questions,
          resolve,
        });
      });

      emitRuntimeEvent(input.runtimeEventQueue, {
        ...providerEventBase(context, turnId ? { turnId } : undefined),
        requestId: RuntimeRequestId.makeUnsafe(requestId),
        type: "user-input.requested",
        payload: {
          questions,
        },
        providerRefs: nativeProviderRefs(context, { providerItemId }),
      });

      const abortSignal = callbackOptions?.signal;
      let aborted = false;
      const onAbort = () => {
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return;
        }
        aborted = true;
        context.pendingUserInputs.delete(requestId);
        pending.resolve({});
      };
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      const resolvedAnswers = await answers;
      abortSignal?.removeEventListener("abort", onAbort);
      context.pendingUserInputs.delete(requestId);

      emitRuntimeEvent(input.runtimeEventQueue, {
        ...providerEventBase(context, turnId ? { turnId } : undefined),
        requestId: RuntimeRequestId.makeUnsafe(requestId),
        type: "user-input.resolved",
        payload: {
          answers: resolvedAnswers,
        },
        providerRefs: nativeProviderRefs(context, { providerItemId }),
      });

      if (aborted || abortSignal?.aborted) {
        return {
          behavior: "deny",
          message: "User cancelled tool execution.",
          interrupt: true,
        } satisfies PermissionResult;
      }

      return {
        behavior: "allow",
        updatedInput: {
          ...toolInput,
          answers: resolvedAnswers,
        },
      } satisfies PermissionResult;
    }

    if (toolName === "ExitPlanMode") {
      const planMarkdown = extractExitPlanModePlan(toolInput);
      if (planMarkdown) {
        input.onExitPlanMode?.({
          context,
          planMarkdown,
          toolUseId: providerItemId,
          rawPayload: {
            toolName,
            input: toolInput,
          },
        });
      }

      return {
        behavior: "deny",
        message:
          "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
      } satisfies PermissionResult;
    }

    if (context.session.runtimeMode !== "approval-required") {
      return { behavior: "allow" } satisfies PermissionResult;
    }

    const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
    const requestType = classifyRequestType(toolName);
    const detail = summarizeToolRequest(toolName, toolInput);

    const decision = new Promise<ProviderApprovalDecision>((resolve) => {
      context.pendingApprovals.set(requestId, {
        requestId,
        requestType,
        ...(detail ? { detail } : {}),
        resolve,
      });
    });

    emitRuntimeEvent(input.runtimeEventQueue, {
      ...providerEventBase(context, turnId ? { turnId } : undefined),
      requestId: RuntimeRequestId.makeUnsafe(requestId),
      type: "request.opened",
      payload: {
        requestType,
        ...(detail ? { detail } : {}),
        args: {
          toolName,
          input: toolInput,
          ...(providerItemId ? { toolUseId: providerItemId } : {}),
        },
      },
      providerRefs: nativeProviderRefs(context, { providerItemId }),
    });

    const resolvedDecision = await decision;
    context.pendingApprovals.delete(requestId);

    emitRuntimeEvent(input.runtimeEventQueue, {
      ...providerEventBase(context, turnId ? { turnId } : undefined),
      requestId: RuntimeRequestId.makeUnsafe(requestId),
      type: "request.resolved",
      payload: {
        requestType,
        decision: resolvedDecision,
        resolution: {
          toolName,
        },
      },
      providerRefs: nativeProviderRefs(context, { providerItemId }),
    });

    if (resolvedDecision === "accept" || resolvedDecision === "acceptForSession") {
      const result: PermissionResult = { behavior: "allow" };
      return result;
    }

    const result: PermissionResult = {
      behavior: "deny",
      message: "Denied by OCI Code approval policy.",
      ...(resolvedDecision === "cancel" ? { interrupt: true } : {}),
    };
    return result;
  };
}

const makeClaudeAdapter = (options?: ClaudeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const providerToolHost = yield* ProviderToolHost;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const localSessions = new Map<ThreadId, ClaudeSessionContext>();
    const remoteSessions = new Map<ThreadId, ProviderSession>();
    const remoteSessionBridgeByThreadId = new Map<ThreadId, RemoteBridgeConfig>();
    const remoteBridgeUnsubscribers = new Map<string, Array<() => void>>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const createQuery =
      options?.createQuery ??
      ((input: {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }) => query(input));

    const subscribeToRemoteBridge = (bridge: RemoteBridgeConfig) => {
      const key = `${bridge.baseUrl}\n${bridge.sharedSecret}`;
      if (remoteBridgeUnsubscribers.has(key)) {
        return;
      }

      const client = getRemoteProviderBridgeClient(bridge);
      const unsubscribeEvents = client.subscribe((event) => {
        if (event.provider !== PROVIDER || !remoteSessionBridgeByThreadId.has(event.threadId)) {
          return;
        }
        void Effect.runFork(Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid));
      });
      const unsubscribeToolRequests = client.subscribeToolRequests(async (request) => {
        const session = remoteSessions.get(request.threadId);
        const requestBridge = remoteSessionBridgeByThreadId.get(request.threadId);
        if (!session || !requestBridge) {
          return { handled: false };
        }
        if (
          requestBridge.baseUrl !== bridge.baseUrl ||
          requestBridge.sharedSecret !== bridge.sharedSecret
        ) {
          return { handled: false };
        }

        try {
          const result = await Effect.runPromise(
            providerToolHost.callTool({
              threadId: request.threadId,
              toolName: request.toolName,
              args: request.arguments,
              ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
            }),
          );
          return { handled: true, result } as const;
        } catch (error) {
          return {
            handled: true,
            error: error instanceof Error ? error.message : String(error),
          } as const;
        }
      });

      remoteBridgeUnsubscribers.set(key, [unsubscribeEvents, unsubscribeToolRequests]);
    };

    const remoteRequest = <T>(
      bridge: RemoteBridgeConfig,
      threadId: ThreadId,
      method: string,
      payload: Record<string, unknown>,
      decode: (input: unknown) => T,
    ) =>
      Effect.tryPromise({
        try: () => getRemoteProviderBridgeClient(bridge).request(method, payload, decode),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, `Claude remote request failed for ${method}.`),
            cause,
          }),
      });

    const makeEventStamp = () => ({
      eventId: EventId.makeUnsafe(crypto.randomUUID()),
      createdAt: new Date().toISOString(),
    });

    const logNativeSdkMessage = async (context: ClaudeSessionContext, message: SDKMessage) => {
      if (!nativeEventLogger) {
        return;
      }
      await Effect.runPromise(
        nativeEventLogger.write(
          {
            observedAt: new Date().toISOString(),
            event: {
              id:
                "uuid" in message && typeof message.uuid === "string"
                  ? message.uuid
                  : crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              threadId: context.session.threadId,
              createdAt: new Date().toISOString(),
              method: `claude/${message.type}`,
              ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              payload: message,
            },
          },
          context.session.threadId,
        ),
      ).catch(() => undefined);
    };

    const ensureAssistantTextBlock = (context: ClaudeSessionContext, blockIndex: number) => {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }
      const existing = turnState.assistantTextBlocks.get(blockIndex);
      if (existing && !existing.completionEmitted) {
        return existing;
      }
      const block: AssistantTextBlockState = {
        itemId: crypto.randomUUID(),
        blockIndex,
        emittedTextDelta: false,
        fallbackText: "",
        streamClosed: false,
        completionEmitted: false,
      };
      turnState.assistantTextBlocks.set(blockIndex, block);
      turnState.assistantTextBlockOrder.push(block);
      return block;
    };

    const completeAssistantTextBlock = (
      context: ClaudeSessionContext,
      block: AssistantTextBlockState,
      _rawPayload?: unknown,
    ) => {
      const turnState = context.turnState;
      if (!turnState || block.completionEmitted || !block.streamClosed) {
        return;
      }
      if (!block.emittedTextDelta && block.fallbackText.length > 0) {
        const deltaStamp = makeEventStamp();
        emitRuntimeEvent(runtimeEventQueue, {
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          itemId: asRuntimeItemId(block.itemId),
          payload: {
            streamKind: "assistant_text",
            delta: block.fallbackText,
          },
          providerRefs: nativeProviderRefs(context),
        });
      }

      block.completionEmitted = true;
      turnState.assistantTextBlocks.delete(block.blockIndex);
      const stamp = makeEventStamp();
      emitRuntimeEvent(runtimeEventQueue, {
        type: "item.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
        },
        providerRefs: nativeProviderRefs(context),
      });
    };

    const emitRuntimeError = (context: ClaudeSessionContext, message: string, cause?: unknown) => {
      const stamp = makeEventStamp();
      emitRuntimeEvent(runtimeEventQueue, {
        type: "runtime.error",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        payload: {
          message,
          class: "provider_error",
          ...(cause !== undefined ? { detail: cause } : {}),
        },
        providerRefs: nativeProviderRefs(context),
      });
    };

    const emitRuntimeWarning = (
      context: ClaudeSessionContext,
      message: string,
      detail?: unknown,
    ) => {
      const stamp = makeEventStamp();
      emitRuntimeEvent(runtimeEventQueue, {
        type: "runtime.warning",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        payload: {
          message,
          ...(detail !== undefined ? { detail } : {}),
        },
        providerRefs: nativeProviderRefs(context),
      });
    };

    const emitProposedPlanCompleted = (
      context: ClaudeSessionContext,
      planMarkdown: string,
      toolUseId?: string,
      _rawPayload?: unknown,
    ) => {
      const turnState = context.turnState;
      const trimmed = planMarkdown.trim();
      if (!turnState || trimmed.length === 0) {
        return;
      }
      const captureKey = exitPlanCaptureKey({ toolUseId, planMarkdown: trimmed });
      if (turnState.capturedProposedPlanKeys.has(captureKey)) {
        return;
      }
      turnState.capturedProposedPlanKeys.add(captureKey);
      const stamp = makeEventStamp();
      emitRuntimeEvent(runtimeEventQueue, {
        type: "turn.proposed.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          planMarkdown: trimmed,
        },
        providerRefs: nativeProviderRefs(context, { providerItemId: toolUseId }),
      });
    };

    const completeTurn = (
      context: ClaudeSessionContext,
      status: ProviderRuntimeTurnStatus,
      errorMessage?: string,
      result?: SDKResultMessage,
    ) => {
      const turnState = context.turnState;
      const usageSnapshot = normalizeClaudeTokenUsage(
        result?.usage,
        maxClaudeContextWindowFromModelUsage(result?.modelUsage),
      );

      if (turnState) {
        for (const block of turnState.assistantTextBlockOrder) {
          block.streamClosed = true;
          completeAssistantTextBlock(context, block, result);
        }
        context.turns.push({
          id: turnState.turnId,
          items: [...turnState.items],
          ...(turnState.assistantUuid ? { assistantUuid: turnState.assistantUuid } : {}),
        });
      }

      if (usageSnapshot) {
        const usageStamp = makeEventStamp();
        emitRuntimeEvent(runtimeEventQueue, {
          type: "thread.token-usage.updated",
          eventId: usageStamp.eventId,
          provider: PROVIDER,
          createdAt: usageStamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: turnState.turnId } : {}),
          payload: {
            usage: usageSnapshot,
          },
          providerRefs: nativeProviderRefs(context),
        });
      }

      const stamp = makeEventStamp();
      emitRuntimeEvent(runtimeEventQueue, {
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(turnState ? { turnId: turnState.turnId } : {}),
        payload: {
          state: status,
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        providerRefs: nativeProviderRefs(context),
      });

      context.turnState = undefined;
      context.session = {
        ...context.session,
        status: "ready",
        activeTurnId: undefined,
        updatedAt: new Date().toISOString(),
        ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
      };
      updateResumeCursor(context);
    };

    const stopLocalSessionContext = async (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ) => {
      if (context.stopped) {
        return;
      }
      context.stopped = true;
      for (const pending of context.pendingApprovals.values()) {
        pending.resolve("cancel");
      }
      context.pendingApprovals.clear();
      for (const pending of context.pendingUserInputs.values()) {
        pending.resolve({});
      }
      context.pendingUserInputs.clear();
      if (context.turnState) {
        completeTurn(context, "interrupted", "Session stopped.");
      }
      try {
        context.query.close();
      } catch (error) {
        emitRuntimeError(context, "Failed to close Claude runtime query.", error);
      }
      await Effect.runPromise(Queue.shutdown(context.promptQueue)).catch(() => undefined);
      await Effect.runPromise(providerToolHost.closeSession(context.session.threadId)).catch(
        () => undefined,
      );
      context.session = {
        ...context.session,
        status: "closed",
        activeTurnId: undefined,
        updatedAt: new Date().toISOString(),
      };
      if (options?.emitExitEvent !== false) {
        const stamp = makeEventStamp();
        emitRuntimeEvent(runtimeEventQueue, {
          type: "session.exited",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          payload: {
            reason: "Session stopped",
            exitKind: "graceful",
          },
          providerRefs: {},
        });
      }
      localSessions.delete(context.session.threadId);
    };

    const handleSdkMessage = async (context: ClaudeSessionContext, message: SDKMessage) => {
      if (typeof message.session_id === "string" && message.session_id.length > 0) {
        context.resumeSessionId = message.session_id;
        if (context.lastThreadStartedId !== message.session_id) {
          context.lastThreadStartedId = message.session_id;
          const threadStamp = makeEventStamp();
          emitRuntimeEvent(runtimeEventQueue, {
            type: "thread.started",
            eventId: threadStamp.eventId,
            provider: PROVIDER,
            createdAt: threadStamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              providerThreadId: message.session_id,
            },
            providerRefs: {},
          });
        }
      }
      await logNativeSdkMessage(context, message);

      if (message.type === "tool_progress") {
        const stamp = makeEventStamp();
        emitRuntimeEvent(runtimeEventQueue, {
          type: "tool.progress",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          payload: {
            toolUseId: message.tool_use_id,
            toolName: message.tool_name,
            elapsedSeconds: message.elapsed_time_seconds,
            ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
        return;
      }

      if (message.type === "tool_use_summary") {
        const stamp = makeEventStamp();
        emitRuntimeEvent(runtimeEventQueue, {
          type: "tool.summary",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          payload: {
            summary: message.summary,
            ...(message.preceding_tool_use_ids.length > 0
              ? { precedingToolUseIds: message.preceding_tool_use_ids }
              : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
        return;
      }

      if (message.type === "auth_status") {
        const stamp = makeEventStamp();
        emitRuntimeEvent(runtimeEventQueue, {
          type: "auth.status",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          payload: {
            isAuthenticating: message.isAuthenticating,
            output: message.output,
            ...(message.error ? { error: message.error } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
        return;
      }

      if (message.type === "rate_limit_event") {
        const stamp = makeEventStamp();
        emitRuntimeEvent(runtimeEventQueue, {
          type: "account.rate-limits.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          payload: {
            rateLimits: message,
          },
          providerRefs: nativeProviderRefs(context),
        });
        return;
      }

      if (message.type === "stream_event") {
        const event = message.event as unknown as Record<string, unknown>;
        if (
          event.type === "content_block_delta" &&
          context.turnState &&
          typeof event.delta === "object" &&
          event.delta !== null
        ) {
          const delta = event.delta as Record<string, unknown>;
          const deltaType = typeof delta.type === "string" ? delta.type : undefined;
          if (
            (deltaType === "text_delta" || deltaType === "thinking_delta") &&
            typeof event.index === "number"
          ) {
            const block =
              deltaType === "text_delta"
                ? ensureAssistantTextBlock(context, event.index)
                : context.turnState.assistantTextBlocks.get(event.index);
            const deltaText =
              deltaType === "text_delta"
                ? typeof delta.text === "string"
                  ? delta.text
                  : ""
                : typeof delta.thinking === "string"
                  ? delta.thinking
                  : "";
            if (block && deltaType === "text_delta") {
              block.emittedTextDelta = true;
            }
            if (deltaText.length > 0) {
              const stamp = makeEventStamp();
              emitRuntimeEvent(runtimeEventQueue, {
                type: "content.delta",
                eventId: stamp.eventId,
                provider: PROVIDER,
                createdAt: stamp.createdAt,
                threadId: context.session.threadId,
                turnId: context.turnState.turnId,
                ...(block ? { itemId: asRuntimeItemId(block.itemId) } : {}),
                payload: {
                  streamKind: streamKindFromDeltaType(deltaType),
                  delta: deltaText,
                },
                providerRefs: nativeProviderRefs(context),
              });
            }
            return;
          }

          if (deltaType === "input_json_delta" && typeof event.index === "number") {
            const tool = context.inFlightTools.get(event.index);
            if (!tool || typeof delta.partial_json !== "string") {
              return;
            }
            const partialInputJson = tool.partialInputJson + delta.partial_json;
            const parsedInput = tryParseJsonRecord(partialInputJson);
            const detail = parsedInput
              ? summarizeToolRequest(tool.toolName, parsedInput)
              : tool.detail;
            const nextFingerprint =
              parsedInput && Object.keys(parsedInput).length > 0
                ? toolInputFingerprint(parsedInput)
                : undefined;
            const nextTool: ToolInFlight = {
              ...tool,
              partialInputJson,
              ...(parsedInput ? { input: parsedInput } : {}),
              ...(detail ? { detail } : {}),
              ...(nextFingerprint !== undefined
                ? { lastEmittedInputFingerprint: nextFingerprint }
                : {}),
            };
            context.inFlightTools.set(event.index, nextTool);
            if (
              parsedInput &&
              nextFingerprint &&
              tool.lastEmittedInputFingerprint !== nextFingerprint
            ) {
              const stamp = makeEventStamp();
              emitRuntimeEvent(runtimeEventQueue, {
                type: "item.updated",
                eventId: stamp.eventId,
                provider: PROVIDER,
                createdAt: stamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
                itemId: asRuntimeItemId(nextTool.itemId),
                payload: {
                  itemType: nextTool.itemType,
                  status: "inProgress",
                  title: nextTool.title,
                  ...(nextTool.detail ? { detail: nextTool.detail } : {}),
                  data: {
                    toolName: nextTool.toolName,
                    input: nextTool.input,
                  },
                },
                providerRefs: nativeProviderRefs(context, { providerItemId: nextTool.itemId }),
              });
            }
            return;
          }
        }

        if (event.type === "content_block_start" && typeof event.index === "number") {
          const block = (event.content_block ?? {}) as Record<string, unknown>;
          if (block.type === "text") {
            const assistantBlock = ensureAssistantTextBlock(context, event.index);
            if (assistantBlock) {
              assistantBlock.fallbackText = extractContentBlockText(block);
            }
            return;
          }

          const toolType = typeof block.type === "string" ? block.type : "";
          if (!["tool_use", "server_tool_use", "mcp_tool_use"].includes(toolType)) {
            return;
          }

          const toolName = typeof block.name === "string" ? block.name : "Tool";
          const itemType = classifyToolItemType(toolName);
          const toolInput =
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {};
          const itemId = typeof block.id === "string" ? block.id : crypto.randomUUID();
          const tool: ToolInFlight = {
            itemId,
            itemType,
            toolName,
            title: titleForTool(itemType),
            detail: summarizeToolRequest(toolName, toolInput),
            input: toolInput,
            partialInputJson: "",
            ...(() => {
              const fingerprint =
                Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;
              return fingerprint !== undefined ? { lastEmittedInputFingerprint: fingerprint } : {};
            })(),
          };
          context.inFlightTools.set(event.index, tool);
          const stamp = makeEventStamp();
          emitRuntimeEvent(runtimeEventQueue, {
            type: "item.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: {
                toolName: tool.toolName,
                input: tool.input,
              },
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          });
          return;
        }

        if (event.type === "content_block_stop" && typeof event.index === "number") {
          const assistantBlock = context.turnState?.assistantTextBlocks.get(event.index);
          if (assistantBlock) {
            assistantBlock.streamClosed = true;
            completeAssistantTextBlock(context, assistantBlock, message);
            return;
          }
        }

        return;
      }

      if (message.type === "user") {
        if (context.turnState) {
          context.turnState.items.push(message.message);
        }
        for (const toolResult of toolResultBlocksFromUserMessage(message)) {
          const toolEntry = Array.from(context.inFlightTools.entries()).find(
            ([, tool]) => tool.itemId === toolResult.toolUseId,
          );
          if (!toolEntry) {
            continue;
          }
          const [index, tool] = toolEntry;
          const streamKind = toolResultStreamKind(tool.itemType);
          if (streamKind && toolResult.text.length > 0 && context.turnState) {
            const deltaStamp = makeEventStamp();
            emitRuntimeEvent(runtimeEventQueue, {
              type: "content.delta",
              eventId: deltaStamp.eventId,
              provider: PROVIDER,
              createdAt: deltaStamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              itemId: asRuntimeItemId(tool.itemId),
              payload: {
                streamKind,
                delta: toolResult.text,
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            });
          }
          const completedStamp = makeEventStamp();
          emitRuntimeEvent(runtimeEventQueue, {
            type: "item.completed",
            eventId: completedStamp.eventId,
            provider: PROVIDER,
            createdAt: completedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: toolResult.isError ? "failed" : "completed",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: {
                toolName: tool.toolName,
                input: tool.input,
                result: toolResult.block,
              },
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
          });
          context.inFlightTools.delete(index);
        }
        return;
      }

      if (message.type === "assistant") {
        if (!context.turnState) {
          const syntheticTurnId = TurnId.makeUnsafe(crypto.randomUUID());
          context.turnState = {
            turnId: syntheticTurnId,
            startedAt: new Date().toISOString(),
            items: [],
            assistantTextBlocks: new Map(),
            assistantTextBlockOrder: [],
            capturedProposedPlanKeys: new Set(),
            nextSyntheticAssistantBlockIndex: -1,
          };
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: syntheticTurnId,
            updatedAt: new Date().toISOString(),
          };
          const turnStartedStamp = makeEventStamp();
          emitRuntimeEvent(runtimeEventQueue, {
            type: "turn.started",
            eventId: turnStartedStamp.eventId,
            provider: PROVIDER,
            createdAt: turnStartedStamp.createdAt,
            threadId: context.session.threadId,
            turnId: syntheticTurnId,
            payload: {},
            providerRefs: nativeProviderRefs(context),
          });
        }
        if (context.turnState) {
          context.turnState.items.push(message.message);
          const snapshotTextBlocks = extractAssistantTextBlocks(message);
          for (const [index, text] of snapshotTextBlocks.entries()) {
            const block = ensureAssistantTextBlock(context, index);
            if (!block) {
              continue;
            }
            if (block.fallbackText.length === 0) {
              block.fallbackText = text;
            }
          }
        }
        const content = (message.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") {
              continue;
            }
            const toolUse = block as {
              type?: unknown;
              id?: unknown;
              name?: unknown;
              input?: unknown;
            };
            if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
              continue;
            }
            const planMarkdown = extractExitPlanModePlan(toolUse.input);
            if (planMarkdown) {
              emitProposedPlanCompleted(
                context,
                planMarkdown,
                typeof toolUse.id === "string" ? toolUse.id : undefined,
                message,
              );
            }
          }
        }
        if ("uuid" in message && typeof message.uuid === "string") {
          context.lastAssistantUuid = message.uuid;
          if (context.turnState) {
            context.turnState.assistantUuid = message.uuid;
          }
        }
        updateResumeCursor(context);
        return;
      }

      if (message.type === "system") {
        emitRuntimeWarning(
          context,
          `Unhandled Claude system message subtype '${message.subtype}'.`,
          message,
        );
        return;
      }

      if (message.type === "result") {
        const status = !message.is_error
          ? "completed"
          : isInterruptedResult(message)
            ? "interrupted"
            : "failed";
        const errorMessage = resultErrorMessage(message);
        if (status === "failed") {
          emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
        }
        completeTurn(context, status, errorMessage, message);
        return;
      }

      emitRuntimeWarning(context, `Unhandled Claude SDK message type '${message.type}'.`, message);
    };

    const startLocalSessionLoop = (context: ClaudeSessionContext) => {
      return Effect.runFork(
        Effect.promise(async () => {
          for await (const message of context.query) {
            if (context.stopped) {
              break;
            }
            await handleSdkMessage(context, message);
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              if (context.stopped) {
                return;
              }
              const message = messageFromClaudeStreamCause(cause, "Claude runtime stream failed.");
              emitRuntimeError(context, message);
              if (context.turnState) {
                completeTurn(
                  context,
                  isClaudeInterruptedCause(cause) ? "interrupted" : "failed",
                  isClaudeInterruptedCause(cause)
                    ? interruptionMessageFromClaudeCause(cause)
                    : message,
                );
              }
            }),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              if (!context.stopped && context.turnState) {
                completeTurn(context, "interrupted", "Claude runtime stream ended.");
              }
            }),
          ),
          Effect.ensuring(
            Effect.promise(() =>
              stopLocalSessionContext(context, {
                emitExitEvent: !context.stopped,
              }),
            ),
          ),
        ),
      );
    };

    const startSession: ClaudeAdapterShape["startSession"] = (input) => {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          }),
        );
      }

      const executionMode = readExecutionMode({
        providerOptions: input.providerOptions,
      });
      if (executionMode === "disabled") {
        return Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Claude is disabled for this thread.",
          }),
        );
      }

      if (executionMode === "remote") {
        const bridge = readRemoteBridgeConfig({
          providerOptions: input.providerOptions,
        });
        if (!bridge) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Remote Claude mode requires a remote bridge URL and shared secret.",
            }),
          );
        }

        subscribeToRemoteBridge(bridge);
        return remoteProviderBridgeStartSession({
          ...bridge,
          payload: normalizeRemoteBridgeStartInput(input),
        }).pipe(
          Effect.tap((session) =>
            Effect.sync(() => {
              const sessionForLocalWorkspace: ProviderSession = {
                ...session,
                runtimeMode: input.runtimeMode,
                ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
              };
              remoteSessions.set(session.threadId, sessionForLocalWorkspace);
              remoteSessionBridgeByThreadId.set(session.threadId, bridge);
            }),
          ),
          Effect.map((session) => ({
            ...session,
            runtimeMode: input.runtimeMode,
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          })),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: toMessage(cause, "Failed to start remote Claude session."),
                cause,
              }),
          ),
        );
      }

      return Effect.gen(function* () {
        const resumeState = readResumeState(input.resumeCursor);
        const binaryPath = readClaudeBinaryPath({
          providerOptions: input.providerOptions,
        });
        const workspaceProxyMode = readWorkspaceProxyMode({
          providerOptions: input.providerOptions,
        });
        const workspaceProxy =
          workspaceProxyMode === "local-proxy"
            ? yield* providerToolHost.openSession(input.threadId).pipe(
                Effect.map(({ token }) =>
                  buildWorkspaceProxyConfig({
                    serverPort: serverConfig.port,
                    token,
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: toMessage(
                        cause,
                        "Failed to prepare the local Claude workspace proxy.",
                      ),
                      cause,
                    }),
                ),
              )
            : undefined;

        const now = new Date().toISOString();
        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        let contextRef: ClaudeSessionContext | undefined;
        const canUseTool = buildCanUseTool({
          getContext: () => contextRef,
          runtimeEventQueue,
          onExitPlanMode: ({ context, planMarkdown, toolUseId, rawPayload }) => {
            emitProposedPlanCompleted(context, planMarkdown, toolUseId, rawPayload);
          },
        });
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          createdAt: now,
          updatedAt: now,
          model: normalizedClaudeModel(input.model),
          cwd: workspaceProxy ? serverConfig.cwd : (input.cwd ?? serverConfig.cwd),
          ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        };

        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.filter(
            (item): item is Extract<PromptQueueItem, { type: "message" }> =>
              item.type === "message",
          ),
          Stream.map((item) => item.message),
          Stream.toAsyncIterable,
        );

        const basePermissionMode =
          workspaceProxy || input.runtimeMode !== "full-access"
            ? ("default" as PermissionMode)
            : ("bypassPermissions" as PermissionMode);
        const queryOptions = buildClaudeQueryOptions({
          context: {
            session,
            promptQueue,
            query: undefined as never,
            streamFiber: undefined,
            startedAt: now,
            basePermissionMode,
            currentModel: session.model,
            turns: [],
            pendingApprovals: new Map(),
            pendingUserInputs: new Map(),
            inFlightTools: new Map(),
            turnState: undefined,
            lastKnownContextWindow: undefined,
            lastKnownTokenUsage: undefined,
            lastAssistantUuid: undefined,
            lastThreadStartedId: undefined,
            resumeSessionId: resumeState.resume,
            resumeSessionAt: resumeState.resumeSessionAt,
            workspaceProxy,
            binaryPath,
            stopped: false,
          },
          model: session.model ?? DEFAULT_MODEL,
          ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
          ...(binaryPath ? { binaryPath } : {}),
          canUseTool,
        });
        const queryRuntime = createQuery({
          prompt,
          options: queryOptions,
        });

        const context: ClaudeSessionContext = {
          session,
          promptQueue,
          query: queryRuntime,
          streamFiber: undefined,
          startedAt: now,
          basePermissionMode,
          currentModel: session.model,
          turns: [],
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          inFlightTools: new Map(),
          turnState: undefined,
          lastKnownContextWindow: undefined,
          lastKnownTokenUsage: undefined,
          lastAssistantUuid: resumeState.resumeSessionAt,
          lastThreadStartedId: undefined,
          resumeSessionId: resumeState.resume,
          resumeSessionAt: resumeState.resumeSessionAt,
          workspaceProxy,
          binaryPath,
          stopped: false,
        };
        contextRef = context;
        updateResumeCursor(context);
        localSessions.set(input.threadId, context);

        emitRuntimeEvent(runtimeEventQueue, {
          ...providerEventBase(context),
          type: "session.started",
          payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        });
        emitRuntimeEvent(runtimeEventQueue, {
          ...providerEventBase(context),
          type: "session.configured",
          payload: {
            config: {
              model: session.model,
              cwd: session.cwd,
              executionMode: "local",
              ...(basePermissionMode ? { permissionMode: basePermissionMode } : {}),
              ...(workspaceProxy ? { workspaceProxyMode: workspaceProxy.mode } : {}),
            },
          },
        });
        emitRuntimeEvent(runtimeEventQueue, {
          ...providerEventBase(context),
          type: "session.state.changed",
          payload: {
            state: "ready",
          },
        });

        context.streamFiber = startLocalSessionLoop(context);

        return context.session;
      });
    };

    const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const remoteBridge = remoteSessionBridgeByThreadId.get(input.threadId);
        if (remoteBridge) {
          return yield* remoteProviderBridgeSendTurn({
            ...remoteBridge,
            payload: input,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: toMessage(cause, "Failed to start the remote Claude turn."),
                  cause,
                }),
            ),
          );
        }

        const context = yield* requireLocalSessionEffect(localSessions, input.threadId);

        const builtUserMessage = yield* buildUserMessageEffect(input, {
          fileSystem,
          stateDir: serverConfig.stateDir,
        });

        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const nextModel = normalizedClaudeModel(
          input.model ?? context.currentModel ?? context.session.model,
        );
        if (nextModel !== context.currentModel) {
          yield* Effect.tryPromise({
            try: () => context.query.setModel(nextModel),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/setModel",
                detail: toMessage(cause, "Failed to update Claude model."),
                cause,
              }),
          });
          context.currentModel = nextModel;
        }
        context.turnState = {
          turnId,
          startedAt: new Date().toISOString(),
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          capturedProposedPlanKeys: new Set(),
          nextSyntheticAssistantBlockIndex: -1,
        };
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: new Date().toISOString(),
          model: nextModel,
        };
        context.currentModel = nextModel;

        if (input.interactionMode === "plan") {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode("plan" as PermissionMode),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/setPermissionMode",
                detail: toMessage(cause, "Failed to enter Claude plan mode."),
                cause,
              }),
          });
        } else if (input.interactionMode === "default" && context.basePermissionMode) {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode(context.basePermissionMode!),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/setPermissionMode",
                detail: toMessage(cause, "Failed to restore Claude permission mode."),
                cause,
              }),
          });
        }

        emitRuntimeEvent(runtimeEventQueue, {
          ...providerEventBase(context, { turnId }),
          type: "turn.started",
          payload: {
            model: context.session.model,
          },
        });
        emitRuntimeEvent(runtimeEventQueue, {
          ...providerEventBase(context, { turnId }),
          type: "session.state.changed",
          payload: {
            state: "running",
          },
        });

        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message: builtUserMessage.promptMessage,
        }).pipe(Effect.asVoid);

        return {
          threadId: input.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const remoteBridge = remoteSessionBridgeByThreadId.get(threadId);
        if (remoteBridge) {
          yield* remoteRequest(
            remoteBridge,
            threadId,
            "providerBridge.interruptTurn",
            { threadId },
            Schema.decodeUnknownSync(Schema.Unknown),
          );
          return;
        }

        const context = yield* requireLocalSessionEffect(localSessions, threadId);
        yield* Effect.tryPromise({
          try: () => context.query.interrupt(),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/interrupt",
              detail: toMessage(cause, "Failed to interrupt the Claude turn."),
              cause,
            }),
        });
      });

    const respondToRequest: ClaudeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const remoteBridge = remoteSessionBridgeByThreadId.get(threadId);
        if (remoteBridge) {
          yield* remoteRequest(
            remoteBridge,
            threadId,
            "providerBridge.respondToRequest",
            { threadId, requestId, decision },
            Schema.decodeUnknownSync(Schema.Unknown),
          );
          return;
        }

        const context = yield* requireLocalSessionEffect(localSessions, threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending Claude approval request: ${requestId}`,
          });
        }
        pending.resolve(decision);
      });

    const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const remoteBridge = remoteSessionBridgeByThreadId.get(threadId);
        if (remoteBridge) {
          yield* remoteRequest(
            remoteBridge,
            threadId,
            "providerBridge.respondToUserInput",
            { threadId, requestId, answers },
            Schema.decodeUnknownSync(Schema.Unknown),
          );
          return;
        }

        const context = yield* requireLocalSessionEffect(localSessions, threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/respondToUserInput",
            detail: `Unknown pending Claude user-input request: ${requestId}`,
          });
        }
        context.pendingUserInputs.delete(requestId);
        pending.resolve(answers);
      });

    const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const remoteBridge = remoteSessionBridgeByThreadId.get(threadId);
        if (remoteBridge) {
          yield* remoteRequest(
            remoteBridge,
            threadId,
            "providerBridge.stopSession",
            { threadId },
            Schema.decodeUnknownSync(Schema.Unknown),
          );
          yield* Effect.sync(() => {
            remoteSessions.delete(threadId);
            remoteSessionBridgeByThreadId.delete(threadId);
          });
          return;
        }

        const context = localSessions.get(threadId);
        if (!context) {
          return;
        }
        yield* Effect.promise(() =>
          stopLocalSessionContext(context, {
            emitExitEvent: true,
          }),
        );
      });

    const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const remoteBridge = remoteSessionBridgeByThreadId.get(threadId);
        if (remoteBridge) {
          return yield* remoteProviderBridgeReadThread({
            ...remoteBridge,
            payload: { threadId },
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: toMessage(cause, "Failed to read the remote Claude thread."),
                  cause,
                }),
            ),
          );
        }

        const context = yield* requireLocalSessionEffect(localSessions, threadId);
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: turn.items,
          })),
        };
      });

    const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }

        const remoteBridge = remoteSessionBridgeByThreadId.get(threadId);
        if (remoteBridge) {
          return yield* remoteRequest(
            remoteBridge,
            threadId,
            "providerBridge.rollbackThread",
            { threadId, numTurns },
            Schema.decodeUnknownSync(
              Schema.Struct({
                threadId: ThreadId,
                turns: Schema.Array(
                  Schema.Struct({
                    id: TurnId,
                    items: Schema.Array(Schema.Unknown),
                  }),
                ),
              }),
            ),
          );
        }

        const context = yield* requireLocalSessionEffect(localSessions, threadId);

        const nextLength = Math.max(0, context.turns.length - numTurns);
        context.turns.splice(nextLength);
        context.resumeSessionAt = context.turns[context.turns.length - 1]?.assistantUuid;
        context.lastAssistantUuid = context.resumeSessionAt;
        updateResumeCursor(context);
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: turn.items,
          })),
        };
      });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const unsubscribers of remoteBridgeUnsubscribers.values()) {
          for (const unsubscribe of unsubscribers) {
            unsubscribe();
          }
        }
        remoteBridgeUnsubscribers.clear();
      }),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      readThread,
      rollbackThread,
      listSessions: () =>
        Effect.sync(() => [
          ...Array.from(localSessions.values(), ({ session }) => session),
          ...remoteSessions.values(),
        ]),
      hasSession: (threadId) =>
        Effect.sync(() => localSessions.has(threadId) || remoteSessions.has(threadId)),
      stopAll: () =>
        Effect.gen(function* () {
          for (const threadId of localSessions.keys()) {
            yield* stopSession(threadId).pipe(Effect.ignore({ log: true }));
          }
          for (const threadId of remoteSessions.keys()) {
            yield* stopSession(threadId).pipe(Effect.ignore({ log: true }));
          }
        }),
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeAdapterShape;
  });

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
