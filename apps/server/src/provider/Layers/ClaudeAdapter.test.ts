import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type CanUseTool,
  type Query as ClaudeQuery,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  type ChatImageAttachment,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@ocicode/contracts";
import { Effect, Fiber, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CLAUDE_CONTEXT_1M_BETA } from "../claudeSupport.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { ProviderToolHost } from "../Services/ProviderToolHost.ts";
import { makeClaudeAdapterLive } from "./ClaudeAdapter.ts";

function asThreadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private done = false;
  private failure: unknown | undefined;

  emit(message: SDKMessage): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  finish(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(cause: unknown): void {
    if (this.done) {
      return;
    }
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(cause);
    }
  }

  readonly interrupt = async (): Promise<void> => undefined;
  readonly setModel = async (): Promise<void> => undefined;
  readonly setPermissionMode = async (): Promise<void> => undefined;
  readonly setMaxThinkingTokens = async (): Promise<void> => undefined;
  readonly applyFlagSettings = async (): Promise<void> => undefined;
  readonly getSettings = async (): Promise<Record<string, unknown>> => ({});
  readonly rewindFiles = async (): Promise<{ canRewind: false }> => ({ canRewind: false });
  readonly cancelAsyncMessage = async (): Promise<boolean> => false;
  readonly seedReadState = async (): Promise<void> => undefined;
  readonly enableRemoteControl = async (): Promise<boolean> => false;
  readonly setProactive = async (): Promise<void> => undefined;
  readonly generateSessionTitle = async (): Promise<string> => "";
  readonly askSideQuestion = async (): Promise<string> => "";
  readonly initializationResult = Promise.resolve({});
  readonly supportedCommands: string[] = [];
  readonly supportedModels: string[] = [];
  readonly close = (): void => {
    this.finish();
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value) {
            return Promise.resolve({
              done: false,
              value,
            });
          }
        }
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) {
          return Promise.resolve({
            done: true,
            value: undefined,
          });
        }
        return new Promise((resolve, reject) => {
          this.waiters.push({
            resolve,
            reject,
          });
        });
      },
    };
  }
}

async function collectPromptMessages(
  prompt: AsyncIterable<SDKUserMessage>,
): Promise<ReadonlyArray<SDKUserMessage>> {
  const messages: SDKUserMessage[] = [];
  for await (const message of prompt) {
    messages.push(message);
    break;
  }
  return messages;
}

async function waitForValue<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for value");
}

const providerToolHostTestLayer = Layer.succeed(ProviderToolHost, {
  openSession: () => Effect.succeed({ token: "tool-host-token" }),
  closeSession: () => Effect.void,
  resolveThreadId: () => Effect.succeed(Option.none()),
  callTool: () => Effect.die(new Error("ProviderToolHost.callTool should not be used in test")),
});

function makeTestLayer(input: {
  readonly stateDir: string;
  readonly createQuery: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: Record<string, unknown>;
  }) => ClaudeQuery;
}) {
  return makeClaudeAdapterLive({
    createQuery: ({ prompt, options }) => input.createQuery({ prompt, options }),
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.stateDir)),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerToolHostTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("maps Claude ultrathink to prompt injection and 1M beta in local mode", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocicode-claude-adapter-"));
  let capturedOptions: Record<string, unknown> | undefined;
  let capturedPromptMessages: ReadonlyArray<SDKUserMessage> = [];
  let resolveCapturedPromptMessages!: (messages: ReadonlyArray<SDKUserMessage>) => void;
  const capturedPromptMessagesPromise = new Promise<ReadonlyArray<SDKUserMessage>>((resolve) => {
    resolveCapturedPromptMessages = resolve;
  });

  const layer = makeTestLayer({
    stateDir,
    createQuery: ({ prompt, options }) => {
      capturedOptions = options;
      const query = new FakeClaudeQuery();
      void collectPromptMessages(prompt).then((messages) => {
        capturedPromptMessages = messages;
        resolveCapturedPromptMessages(messages);
        query.emit({
          type: "assistant",
          session_id: "session-1",
          parent_tool_use_id: null,
          uuid: "assistant-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
          },
        } as unknown as SDKMessage);
        query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: null,
          session_id: "session-1",
          total_cost_usd: 0,
          usage: { output_tokens: 1 },
          modelUsage: {},
          permission_denials: [],
          uuid: "result-1",
          result: "Done",
        } as unknown as SDKMessage);
        query.finish();
      });
      return query as unknown as ClaudeQuery;
    },
  });

  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const threadId = asThreadId("thread-claude-ultrathink");

    yield* adapter.startSession({
      provider: "claudeAgent",
      threadId,
      model: "claude-sonnet-4-6",
      runtimeMode: "full-access",
    });

    yield* adapter.sendTurn({
      threadId,
      input: "Review this diff",
      model: "claude-sonnet-4-6",
      modelOptions: {
        claudeAgent: {
          effort: "ultrathink",
          contextWindow: "1m",
        },
      },
      attachments: [],
    });

    yield* Effect.promise(() => capturedPromptMessagesPromise);

    assert.deepStrictEqual(capturedOptions?.betas, [CLAUDE_CONTEXT_1M_BETA]);
    assert.strictEqual(capturedOptions?.effort, "high");
    assert.strictEqual(capturedOptions?.includePartialMessages, true);
    assert.strictEqual(capturedPromptMessages.length, 1);
    assert.deepStrictEqual(capturedPromptMessages[0]?.message.content, [
      { type: "text", text: "Ultrathink:\nReview this diff" },
    ]);

    fs.rmSync(stateDir, { recursive: true, force: true });
  }).pipe(Effect.provide(layer));
});

it.effect("accepts local Claude image attachments", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocicode-claude-attachments-"));
  const attachmentsDir = path.join(stateDir, "attachments");
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const attachment: ChatImageAttachment = {
    type: "image",
    id: "thread-claude-image-11111111-1111-1111-1111-111111111111",
    name: "diagram.png",
    mimeType: "image/png",
    sizeBytes: 4,
  };
  fs.writeFileSync(path.join(attachmentsDir, `${attachment.id}.png`), Buffer.from([1, 2, 3, 4]));

  let capturedPromptMessages: ReadonlyArray<SDKUserMessage> = [];
  let resolveCapturedPromptMessages!: (messages: ReadonlyArray<SDKUserMessage>) => void;
  const capturedPromptMessagesPromise = new Promise<ReadonlyArray<SDKUserMessage>>((resolve) => {
    resolveCapturedPromptMessages = resolve;
  });
  const layer = makeTestLayer({
    stateDir,
    createQuery: ({ prompt }) => {
      const query = new FakeClaudeQuery();
      void collectPromptMessages(prompt).then((messages) => {
        capturedPromptMessages = messages;
        resolveCapturedPromptMessages(messages);
        query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: null,
          session_id: "session-1",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "result-2",
          result: "",
        } as unknown as SDKMessage);
        query.finish();
      });
      return query as unknown as ClaudeQuery;
    },
  });

  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const threadId = asThreadId("thread-claude-image");

    yield* adapter.startSession({
      provider: "claudeAgent",
      threadId,
      model: "claude-haiku-4-5",
      runtimeMode: "full-access",
    });

    yield* adapter.sendTurn({
      threadId,
      input: "",
      model: "claude-haiku-4-5",
      attachments: [attachment],
    });

    yield* Effect.promise(() => capturedPromptMessagesPromise);

    assert.strictEqual(capturedPromptMessages.length, 1);
    const content = capturedPromptMessages[0]?.message.content ?? [];
    assert.strictEqual(Array.isArray(content), true);
    assert.strictEqual(content.length, 1);
    assert.deepStrictEqual(content[0], {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: Buffer.from([1, 2, 3, 4]).toString("base64"),
      },
    });

    fs.rmSync(stateDir, { recursive: true, force: true });
  }).pipe(Effect.provide(layer));
});

it.effect("handles local Claude AskUserQuestion prompts", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocicode-claude-user-input-"));
  let capturedPermissionResult!: PermissionResult;
  let resolveCapturedPermissionResult!: (result: PermissionResult) => void;
  const capturedPermissionResultPromise = new Promise<PermissionResult>((resolve) => {
    resolveCapturedPermissionResult = resolve;
  });

  const layer = makeTestLayer({
    stateDir,
    createQuery: ({ prompt, options }) => {
      const canUseTool = options.canUseTool as CanUseTool | undefined;
      const query = new FakeClaudeQuery();
      void (async () => {
        await collectPromptMessages(prompt);
        if (!canUseTool) {
          query.fail(new Error("Expected Claude canUseTool callback"));
          return;
        }

        const permissionResult = await canUseTool(
          "AskUserQuestion",
          {
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          { signal: new AbortController().signal, toolUseID: "tool-use-1" },
        );
        capturedPermissionResult = permissionResult;
        resolveCapturedPermissionResult(permissionResult);

        query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: null,
          session_id: "session-1",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "result-3",
          result: "",
        } as unknown as SDKMessage);
        query.finish();
      })();

      return query as unknown as ClaudeQuery;
    },
  });

  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const threadId = asThreadId("thread-claude-user-input");
    const emittedEvents: ProviderRuntimeEvent[] = [];
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        emittedEvents.push(event);
      }),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      provider: "claudeAgent",
      threadId,
      model: "claude-sonnet-4-6",
      runtimeMode: "full-access",
    });

    yield* adapter.sendTurn({
      threadId,
      input: "Need user input",
      model: "claude-sonnet-4-6",
      attachments: [],
    });

    const requestedEvent = yield* Effect.promise(() =>
      waitForValue(
        () =>
          emittedEvents.find((event) => event.type === "user-input.requested") as
            | Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>
            | undefined,
      ),
    );

    assert.equal(requestedEvent.payload.questions[0]?.id, "sandbox_mode");
    if (!requestedEvent.requestId) {
      throw new Error("Expected Claude user-input.requested event to include requestId");
    }
    yield* adapter.respondToUserInput(
      threadId,
      ApprovalRequestId.makeUnsafe(requestedEvent.requestId),
      {
        sandbox_mode: "workspace-write",
      },
    );

    const permissionResult = yield* Effect.promise(() => capturedPermissionResultPromise);
    assert.deepEqual(capturedPermissionResult, permissionResult);
    assert.deepEqual(permissionResult, {
      behavior: "allow",
      updatedInput: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const resolvedEvent = yield* Effect.promise(() =>
      waitForValue(
        () =>
          emittedEvents.find((event) => event.type === "user-input.resolved") as
            | Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>
            | undefined,
      ),
    );
    assert.deepEqual(resolvedEvent.payload.answers, {
      sandbox_mode: "workspace-write",
    });

    yield* Fiber.interrupt(eventsFiber);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }).pipe(Effect.provide(layer));
});

it.effect("keeps AskUserQuestion active for local-proxy Claude full-access sessions", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocicode-claude-local-proxy-input-"));
  let capturedPermissionResult!: PermissionResult;
  let capturedOptions: Record<string, unknown> | undefined;
  let resolveCapturedPermissionResult!: (result: PermissionResult) => void;
  const capturedPermissionResultPromise = new Promise<PermissionResult>((resolve) => {
    resolveCapturedPermissionResult = resolve;
  });

  const layer = makeTestLayer({
    stateDir,
    createQuery: ({ prompt, options }) => {
      capturedOptions = options;
      const canUseTool = options.canUseTool as CanUseTool | undefined;
      const query = new FakeClaudeQuery();
      void (async () => {
        await collectPromptMessages(prompt);
        if (!canUseTool) {
          query.fail(new Error("Expected Claude canUseTool callback"));
          return;
        }

        const permissionResult = await canUseTool(
          "AskUserQuestion",
          {
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          { signal: new AbortController().signal, toolUseID: "tool-use-local-proxy-1" },
        );
        capturedPermissionResult = permissionResult;
        resolveCapturedPermissionResult(permissionResult);

        query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: null,
          session_id: "session-local-proxy-1",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "result-local-proxy-1",
          result: "",
        } as unknown as SDKMessage);
        query.finish();
      })();

      return query as unknown as ClaudeQuery;
    },
  });

  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const threadId = asThreadId("thread-claude-local-proxy-input");
    const emittedEvents: ProviderRuntimeEvent[] = [];
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        emittedEvents.push(event);
      }),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      provider: "claudeAgent",
      threadId,
      model: "claude-sonnet-4-6",
      runtimeMode: "full-access",
      providerOptions: {
        claudeAgent: {
          remote: {
            workspaceProxyMode: "local-proxy",
          },
        },
      },
    });

    yield* adapter.sendTurn({
      threadId,
      input: "Need user input",
      model: "claude-sonnet-4-6",
      attachments: [],
    });

    assert.strictEqual(capturedOptions?.includePartialMessages, true);
    assert.strictEqual(capturedOptions?.permissionMode, undefined);
    assert.strictEqual(capturedOptions?.allowDangerouslySkipPermissions, undefined);

    const requestedEvent = yield* Effect.promise(() =>
      waitForValue(
        () =>
          emittedEvents.find((event) => event.type === "user-input.requested") as
            | Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>
            | undefined,
      ),
    );

    assert.equal(requestedEvent.payload.questions[0]?.id, "sandbox_mode");
    if (!requestedEvent.requestId) {
      throw new Error("Expected Claude user-input.requested event to include requestId");
    }

    yield* adapter.respondToUserInput(
      threadId,
      ApprovalRequestId.makeUnsafe(requestedEvent.requestId),
      {
        sandbox_mode: "workspace-write",
      },
    );

    const permissionResult = yield* Effect.promise(() => capturedPermissionResultPromise);
    assert.deepEqual(capturedPermissionResult, permissionResult);
    assert.deepEqual(permissionResult, {
      behavior: "allow",
      updatedInput: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    yield* Fiber.interrupt(eventsFiber);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }).pipe(Effect.provide(layer));
});

it.effect("surfaces approval requests for local-proxy Claude approval-required sessions", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocicode-claude-local-proxy-approval-"));
  let capturedPermissionResult!: PermissionResult;
  let resolveCapturedPermissionResult!: (result: PermissionResult) => void;
  const capturedPermissionResultPromise = new Promise<PermissionResult>((resolve) => {
    resolveCapturedPermissionResult = resolve;
  });

  const layer = makeTestLayer({
    stateDir,
    createQuery: ({ prompt, options }) => {
      const canUseTool = options.canUseTool as CanUseTool | undefined;
      const query = new FakeClaudeQuery();
      void (async () => {
        await collectPromptMessages(prompt);
        if (!canUseTool) {
          query.fail(new Error("Expected Claude canUseTool callback"));
          return;
        }

        const permissionResult = await canUseTool(
          "Bash",
          { command: "pwd" },
          { signal: new AbortController().signal, toolUseID: "tool-use-local-proxy-2" },
        );
        capturedPermissionResult = permissionResult;
        resolveCapturedPermissionResult(permissionResult);

        query.emit({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          stop_reason: null,
          session_id: "session-local-proxy-2",
          total_cost_usd: 0,
          usage: {},
          modelUsage: {},
          permission_denials: [],
          uuid: "result-local-proxy-2",
          result: "",
        } as unknown as SDKMessage);
        query.finish();
      })();

      return query as unknown as ClaudeQuery;
    },
  });

  return Effect.gen(function* () {
    const adapter = yield* ClaudeAdapter;
    const threadId = asThreadId("thread-claude-local-proxy-approval");
    const emittedEvents: ProviderRuntimeEvent[] = [];
    const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        emittedEvents.push(event);
      }),
    ).pipe(Effect.forkChild);

    yield* adapter.startSession({
      provider: "claudeAgent",
      threadId,
      model: "claude-sonnet-4-6",
      runtimeMode: "approval-required",
      providerOptions: {
        claudeAgent: {
          remote: {
            workspaceProxyMode: "local-proxy",
          },
        },
      },
    });

    yield* adapter.sendTurn({
      threadId,
      input: "Run a command",
      model: "claude-sonnet-4-6",
      attachments: [],
    });

    const requestedEvent = yield* Effect.promise(() =>
      waitForValue(
        () =>
          emittedEvents.find((event) => event.type === "request.opened") as
            | Extract<ProviderRuntimeEvent, { type: "request.opened" }>
            | undefined,
      ),
    );

    assert.equal(requestedEvent.payload.requestType, "command_execution_approval");
    if (!requestedEvent.requestId) {
      throw new Error("Expected Claude request.opened event to include requestId");
    }

    yield* adapter.respondToRequest(
      threadId,
      ApprovalRequestId.makeUnsafe(requestedEvent.requestId),
      "accept",
    );

    const permissionResult = yield* Effect.promise(() => capturedPermissionResultPromise);
    assert.deepEqual(capturedPermissionResult, permissionResult);
    assert.deepEqual(permissionResult, {
      behavior: "allow",
    });

    const resolvedEvent = yield* Effect.promise(() =>
      waitForValue(
        () =>
          emittedEvents.find((event) => event.type === "request.resolved") as
            | Extract<ProviderRuntimeEvent, { type: "request.resolved" }>
            | undefined,
      ),
    );
    assert.equal(resolvedEvent.payload.decision, "accept");

    yield* Fiber.interrupt(eventsFiber);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }).pipe(Effect.provide(layer));
});
