import crypto from "node:crypto";

import {
  query,
  type CanUseTool,
  type Options as ClaudeQueryOptions,
  type PermissionResult,
  type Query as ClaudeQuery,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  EventId,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@ocicode/contracts";
import { getDefaultModel, normalizeModelSlug } from "@ocicode/shared/model";
import { normalizeRemoteBridgeStartInput } from "@ocicode/shared/provider";
import { Effect, Layer, Queue, Schema, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type ProviderToolHostShape, ProviderToolHost } from "../Services/ProviderToolHost.ts";
import { type ClaudeAdapterShape, ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import {
  getRemoteProviderBridgeClient,
  remoteProviderBridgeReadThread,
  remoteProviderBridgeSendTurn,
  remoteProviderBridgeStartSession,
} from "../remoteBridgeClient";
import { buildWorkspaceProxyProcessConfig, buildWorkspaceProxyUrl } from "../workspaceProxy.ts";

const PROVIDER = "claudeAgent" as const;
const DEFAULT_MODEL = getDefaultModel(PROVIDER);
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

type PendingApproval = {
  readonly requestId: ApprovalRequestId;
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly resolve: (decision: ProviderApprovalDecision) => void;
};

type ClaudeTurnSnapshot = {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  assistantUuid?: string;
};

type ClaudeSessionContext = {
  session: ProviderSession;
  turns: Array<ClaudeTurnSnapshot>;
  pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  resumeSessionId: string | undefined;
  resumeSessionAt: string | undefined;
  activeQuery: ClaudeQuery | undefined;
  workspaceProxy: WorkspaceProxyConfig | undefined;
  binaryPath: string | undefined;
};

type LocalClaudeRuntime = {
  readonly localSessions: Map<ThreadId, ClaudeSessionContext>;
  readonly runtimeEventQueue: Queue.Queue<ProviderRuntimeEvent>;
  readonly providerToolHost: ProviderToolHostShape;
  readonly serverConfig: {
    readonly port: number;
    readonly cwd: string;
  };
};

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

function extractAssistantText(message: SDKMessage): string {
  if (message.type !== "assistant") {
    return "";
  }

  const content =
    typeof message.message === "object" &&
    message.message !== null &&
    "content" in message.message &&
    Array.isArray((message.message as { content?: unknown }).content)
      ? (message.message as { content: Array<unknown> }).content
      : [];

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const candidate = block as { type?: unknown; text?: unknown; thinking?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        return candidate.text;
      }
      if (candidate.type === "thinking" && typeof candidate.thinking === "string") {
        return candidate.thinking;
      }
      return "";
    })
    .filter((entry) => entry.length > 0)
    .join("");
}

function extractTextDelta(
  message: SDKMessage,
): { streamKind: "assistant_text" | "reasoning_text"; delta: string } | undefined {
  if (message.type !== "stream_event") {
    return undefined;
  }

  const event = message.event as {
    type?: unknown;
    delta?: {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
    };
  };
  if (event.type !== "content_block_delta") {
    return undefined;
  }
  if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
    return { streamKind: "assistant_text", delta: event.delta.text };
  }
  if (event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string") {
    return { streamKind: "reasoning_text", delta: event.delta.thinking };
  }
  return undefined;
}

function toolRequestType(toolName: string): CanonicalRequestType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash")) {
    return "command_execution_approval";
  }
  if (
    normalized.includes("read") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("ls")
  ) {
    return "file_read_approval";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("multiedit")
  ) {
    return "file_change_approval";
  }
  return "unknown";
}

function toolRequestDetail(toolName: string, input: Record<string, unknown>): string | undefined {
  const path =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : undefined;
  if (typeof input.command === "string") {
    return input.command;
  }
  if (path) {
    return `${toolName}: ${path}`;
  }
  const serialized = JSON.stringify(input);
  return serialized === "{}" ? toolName : `${toolName}: ${serialized}`;
}

function promptWithEffort(input: {
  readonly prompt: string;
  readonly effort: string | undefined;
}): string {
  if (!input.effort) {
    return input.prompt;
  }
  return `Reasoning effort: ${input.effort}.\n\n${input.prompt}`;
}

function isInterruptedResult(result: SDKResultMessage): boolean {
  if (result.subtype !== "error_during_execution") {
    return false;
  }
  const text = result.errors.join(" ").toLowerCase();
  return (
    text.includes("interrupt") || text.includes("aborted") || text.includes("interrupted by user")
  );
}

function resultErrorMessage(result: SDKResultMessage): string | undefined {
  if (result.subtype === "success") {
    return undefined;
  }
  const message = result.errors.join(" ").trim();
  return message.length > 0 ? message : undefined;
}

function refreshResumeCursor(context: ClaudeSessionContext): void {
  context.session = {
    ...context.session,
    updatedAt: new Date().toISOString(),
    resumeCursor: {
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      ...(context.resumeSessionAt ? { resumeSessionAt: context.resumeSessionAt } : {}),
      turnCount: context.turns.length,
    },
  };
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
  if (context.session.status === "closed") {
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

function buildClaudeQueryOptions(input: {
  readonly context: ClaudeSessionContext;
  readonly model: string;
  readonly binaryPath?: string;
  readonly canUseTool?: CanUseTool;
  readonly interactionMode?: "default" | "plan";
}): ClaudeQueryOptions {
  const permissionMode =
    input.interactionMode === "plan"
      ? "plan"
      : input.context.workspaceProxy || input.context.session.runtimeMode === "full-access"
        ? "bypassPermissions"
        : "default";

  return {
    model: input.model,
    ...(input.context.session.cwd ? { cwd: input.context.session.cwd } : {}),
    ...(input.binaryPath ? { pathToClaudeCodeExecutable: input.binaryPath } : {}),
    permissionMode,
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(input.context.resumeSessionId ? { resume: input.context.resumeSessionId } : {}),
    ...(input.context.resumeSessionAt ? { resumeSessionAt: input.context.resumeSessionAt } : {}),
    ...(input.canUseTool ? { canUseTool: input.canUseTool } : {}),
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
  readonly context: ClaudeSessionContext;
  readonly turnId: TurnId;
  readonly runtimeEventQueue: Queue.Queue<ProviderRuntimeEvent>;
}): CanUseTool {
  return async (toolName, toolInput) => {
    const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
    const requestType = toolRequestType(toolName);
    const detail = toolRequestDetail(toolName, toolInput);

    const decision = new Promise<ProviderApprovalDecision>((resolve) => {
      input.context.pendingApprovals.set(requestId, {
        requestId,
        requestType,
        ...(detail ? { detail } : {}),
        resolve,
      });
    });

    emitRuntimeEvent(input.runtimeEventQueue, {
      ...providerEventBase(input.context, { turnId: input.turnId }),
      requestId: RuntimeRequestId.makeUnsafe(requestId),
      type: "request.opened",
      payload: {
        requestType,
        ...(detail ? { detail } : {}),
        args: {
          toolName,
          input: toolInput,
        },
      },
    });

    const resolvedDecision = await decision;
    input.context.pendingApprovals.delete(requestId);

    emitRuntimeEvent(input.runtimeEventQueue, {
      ...providerEventBase(input.context, { turnId: input.turnId }),
      requestId: RuntimeRequestId.makeUnsafe(requestId),
      type: "request.resolved",
      payload: {
        requestType,
        decision: resolvedDecision,
        resolution: {
          toolName,
        },
      },
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

async function runLocalClaudeTurn(input: {
  readonly runtime: LocalClaudeRuntime;
  readonly context: ClaudeSessionContext;
  readonly turn: ClaudeTurnSnapshot;
  readonly prompt: string;
  readonly model: string;
  readonly binaryPath?: string;
  readonly interactionMode?: "default" | "plan";
}): Promise<void> {
  const assistantItemId = RuntimeItemId.makeUnsafe(crypto.randomUUID());
  const canUseTool =
    !input.context.workspaceProxy && input.context.session.runtimeMode === "approval-required"
      ? buildCanUseTool({
          context: input.context,
          turnId: input.turn.id,
          runtimeEventQueue: input.runtime.runtimeEventQueue,
        })
      : undefined;

  const queryOptions = buildClaudeQueryOptions({
    context: input.context,
    model: input.model,
    ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
    ...(canUseTool ? { canUseTool } : {}),
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
  });

  const runtimeEvents = input.runtime.runtimeEventQueue;
  let resultMessage: SDKResultMessage | undefined;
  let assistantStarted = false;
  let assistantText = "";

  const turnBase = providerEventBase(input.context, { turnId: input.turn.id });
  emitRuntimeEvent(runtimeEvents, {
    ...turnBase,
    type: "item.completed",
    itemId: RuntimeItemId.makeUnsafe(crypto.randomUUID()),
    payload: {
      itemType: "user_message",
      status: "completed",
      title: "User message",
      detail: input.prompt,
      data: {
        text: input.prompt,
      },
    },
  });

  try {
    const currentQuery = query({
      prompt: input.prompt,
      options: queryOptions,
    });
    input.context.activeQuery = currentQuery;

    for await (const message of currentQuery) {
      if (typeof message.session_id === "string") {
        input.context.resumeSessionId = message.session_id;
      }

      if (message.type === "auth_status") {
        emitRuntimeEvent(runtimeEvents, {
          ...providerEventBase(input.context, { turnId: input.turn.id }),
          type: "auth.status",
          payload: {
            isAuthenticating: message.isAuthenticating,
            output: message.output,
            ...(message.error ? { error: message.error } : {}),
          },
        });
        continue;
      }

      if (message.type === "tool_use_summary") {
        emitRuntimeEvent(runtimeEvents, {
          ...providerEventBase(input.context, { turnId: input.turn.id }),
          type: "tool.summary",
          payload: {
            summary: message.summary,
            precedingToolUseIds: message.preceding_tool_use_ids,
          },
        });
        continue;
      }

      const delta = extractTextDelta(message);
      if (delta) {
        if (!assistantStarted) {
          assistantStarted = true;
          emitRuntimeEvent(runtimeEvents, {
            ...providerEventBase(input.context, { turnId: input.turn.id }),
            itemId: assistantItemId,
            type: "item.started",
            payload: {
              itemType: delta.streamKind === "assistant_text" ? "assistant_message" : "reasoning",
              status: "inProgress",
              title: delta.streamKind === "assistant_text" ? "Assistant message" : "Reasoning",
            },
          });
        }
        assistantText += delta.delta;
        emitRuntimeEvent(runtimeEvents, {
          ...providerEventBase(input.context, { turnId: input.turn.id }),
          itemId: assistantItemId,
          type: "content.delta",
          payload: {
            streamKind: delta.streamKind,
            delta: delta.delta,
          },
        });
        continue;
      }

      if (message.type === "assistant") {
        input.turn.items.push(message.message);
        input.context.resumeSessionAt = message.uuid;
        input.turn.assistantUuid = message.uuid;
        const fullText = extractAssistantText(message);
        if (fullText.length > assistantText.length) {
          const remainder = fullText.slice(assistantText.length);
          if (!assistantStarted) {
            assistantStarted = true;
            emitRuntimeEvent(runtimeEvents, {
              ...providerEventBase(input.context, { turnId: input.turn.id }),
              itemId: assistantItemId,
              type: "item.started",
              payload: {
                itemType: "assistant_message",
                status: "inProgress",
                title: "Assistant message",
              },
            });
          }
          if (remainder.length > 0) {
            assistantText = fullText;
            emitRuntimeEvent(runtimeEvents, {
              ...providerEventBase(input.context, { turnId: input.turn.id }),
              itemId: assistantItemId,
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: remainder,
              },
            });
          }
        }
        continue;
      }

      if (message.type === "result") {
        resultMessage = message;
      }
    }

    if (assistantStarted) {
      emitRuntimeEvent(runtimeEvents, {
        ...providerEventBase(input.context, { turnId: input.turn.id }),
        itemId: assistantItemId,
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(assistantText ? { detail: assistantText } : {}),
          data: {
            text: assistantText,
          },
        },
      });
    }

    input.context.session = {
      ...input.context.session,
      status:
        resultMessage && (resultMessage.is_error || isInterruptedResult(resultMessage))
          ? "error"
          : "ready",
      activeTurnId: undefined,
      updatedAt: new Date().toISOString(),
      ...(resultMessage && resultMessage.is_error
        ? { lastError: resultErrorMessage(resultMessage) ?? input.context.session.lastError }
        : {}),
    };
    refreshResumeCursor(input.context);

    emitRuntimeEvent(runtimeEvents, {
      ...providerEventBase(input.context, { turnId: input.turn.id }),
      type: "turn.completed",
      payload: {
        state:
          !resultMessage || !resultMessage.is_error
            ? "completed"
            : isInterruptedResult(resultMessage)
              ? "interrupted"
              : "failed",
        ...(resultMessage?.stop_reason ? { stopReason: resultMessage.stop_reason } : {}),
        ...(resultMessage?.usage ? { usage: resultMessage.usage } : {}),
        ...(resultMessage?.modelUsage ? { modelUsage: resultMessage.modelUsage } : {}),
        ...(typeof resultMessage?.total_cost_usd === "number"
          ? { totalCostUsd: resultMessage.total_cost_usd }
          : {}),
        ...(resultMessage && resultErrorMessage(resultMessage)
          ? { errorMessage: resultErrorMessage(resultMessage) }
          : {}),
      },
    });
  } catch (cause) {
    const detail = toMessage(cause, "Claude runtime failed while processing the turn.");
    input.context.session = {
      ...input.context.session,
      status: "error",
      activeTurnId: undefined,
      updatedAt: new Date().toISOString(),
      lastError: detail,
    };
    refreshResumeCursor(input.context);
    emitRuntimeEvent(runtimeEvents, {
      ...providerEventBase(input.context, { turnId: input.turn.id }),
      type: "runtime.error",
      payload: {
        message: detail,
        class: "provider_error",
      },
    });
    emitRuntimeEvent(runtimeEvents, {
      ...providerEventBase(input.context, { turnId: input.turn.id }),
      type: "turn.completed",
      payload: {
        state: "failed",
        errorMessage: detail,
      },
    });
  } finally {
    input.context.activeQuery = undefined;
  }
}

const makeClaudeAdapter = () =>
  Effect.gen(function* () {
    const providerToolHost = yield* ProviderToolHost;
    const serverConfig = yield* ServerConfig;

    const localSessions = new Map<ThreadId, ClaudeSessionContext>();
    const remoteSessions = new Map<ThreadId, ProviderSession>();
    const remoteSessionBridgeByThreadId = new Map<ThreadId, RemoteBridgeConfig>();
    const remoteBridgeUnsubscribers = new Map<string, Array<() => void>>();
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const localRuntime: LocalClaudeRuntime = {
      localSessions,
      runtimeEventQueue,
      providerToolHost,
      serverConfig,
    };

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

        const context: ClaudeSessionContext = {
          session,
          turns: [],
          pendingApprovals: new Map(),
          resumeSessionId: resumeState.resume,
          resumeSessionAt: resumeState.resumeSessionAt,
          activeQuery: undefined,
          workspaceProxy,
          binaryPath,
        };
        refreshResumeCursor(context);
        localSessions.set(input.threadId, context);

        emitRuntimeEvent(runtimeEventQueue, {
          ...providerEventBase(context),
          type: "session.started",
          payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
        });
        emitRuntimeEvent(runtimeEventQueue, {
          ...providerEventBase(context),
          type: "session.state.changed",
          payload: {
            state: "ready",
          },
        });

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
        if (context.activeQuery) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: "Claude is already processing a turn for this thread.",
          });
        }
        if (input.attachments && input.attachments.length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Claude image attachments are not supported in this implementation yet.",
          });
        }
        if (!input.input || input.input.trim().length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Claude turns require a non-empty input message.",
          });
        }

        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const prompt = promptWithEffort({
          prompt: input.input.trim(),
          effort: input.modelOptions?.claudeAgent?.effort,
        });
        const turn: ClaudeTurnSnapshot = {
          id: turnId,
          items: [{ type: "user", text: prompt }],
        };
        context.turns.push(turn);
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: new Date().toISOString(),
          model: normalizedClaudeModel(input.model ?? context.session.model),
        };

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

        const model = normalizedClaudeModel(input.model ?? context.session.model);

        void runLocalClaudeTurn({
          runtime: localRuntime,
          context,
          turn,
          prompt,
          model,
          ...(context.binaryPath ? { binaryPath: context.binaryPath } : {}),
          ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        });

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
        if (!context.activeQuery) {
          return;
        }
        yield* Effect.tryPromise({
          try: () => context.activeQuery!.interrupt(),
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
      _answers,
    ) =>
      Effect.gen(function* () {
        const remoteBridge = remoteSessionBridgeByThreadId.get(threadId);
        if (remoteBridge) {
          yield* remoteRequest(
            remoteBridge,
            threadId,
            "providerBridge.respondToUserInput",
            { threadId, requestId, answers: {} satisfies ProviderUserInputAnswers },
            Schema.decodeUnknownSync(Schema.Unknown),
          );
          return;
        }

        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/tool/requestUserInput",
          detail: "Claude local user-input prompts are not implemented in this adapter.",
        });
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
        if (context.activeQuery) {
          context.activeQuery.close();
          context.activeQuery = undefined;
        }
        yield* providerToolHost.closeSession(threadId);
        for (const pending of context.pendingApprovals.values()) {
          pending.resolve("cancel");
        }
        context.pendingApprovals.clear();
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: new Date().toISOString(),
        };
        emitRuntimeEvent(runtimeEventQueue, {
          ...providerEventBase(context),
          type: "session.exited",
          payload: {
            exitKind: "graceful",
            reason: "Session stopped",
          },
        });
        yield* Effect.sync(() => {
          localSessions.delete(threadId);
        });
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
        refreshResumeCursor(context);
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

export function makeClaudeAdapterLive() {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter());
}
