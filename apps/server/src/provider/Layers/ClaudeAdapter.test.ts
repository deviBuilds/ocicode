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
import { CLAUDE_CONTEXT_1M_BETA } from "../claudeSupport.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { ProviderToolHost } from "../Services/ProviderToolHost.ts";
import { makeClaudeAdapterLive } from "./ClaudeAdapter.ts";

function asThreadId(value: string): ThreadId {
  return ThreadId.makeUnsafe(value);
}

function makeFakeQuery(messages: ReadonlyArray<SDKMessage>): ClaudeQuery {
  const iterator = (async function* () {
    for (const message of messages) {
      yield message;
    }
  })();

  return Object.assign(iterator, {
    interrupt: async () => undefined,
    setModel: async () => undefined,
    setPermissionMode: async () => undefined,
    setMaxThinkingTokens: async () => undefined,
    applyFlagSettings: async () => undefined,
    getSettings: async () => ({}),
    rewindFiles: async () => ({ canRewind: false }),
    cancelAsyncMessage: async () => false,
    seedReadState: async () => undefined,
    enableRemoteControl: async () => false,
    setProactive: async () => undefined,
    generateSessionTitle: async () => "",
    askSideQuestion: async () => "",
    initializationResult: Promise.resolve({}),
    supportedCommands: [],
    supportedModels: [],
    close: () => undefined,
  }) as unknown as ClaudeQuery;
}

async function collectPromptMessages(
  prompt: string | AsyncIterable<SDKUserMessage>,
): Promise<ReadonlyArray<SDKUserMessage>> {
  if (typeof prompt === "string") {
    return [];
  }

  const messages: SDKUserMessage[] = [];
  for await (const message of prompt) {
    messages.push(message);
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
    readonly prompt: string | AsyncIterable<SDKUserMessage>;
    readonly options: Record<string, unknown>;
  }) => ClaudeQuery;
}) {
  return makeClaudeAdapterLive({
    createQuery: ({ prompt, options }) => input.createQuery({ prompt, options }),
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.stateDir)),
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
      void collectPromptMessages(prompt).then((messages) => {
        capturedPromptMessages = messages;
        resolveCapturedPromptMessages(messages);
      });
      return makeFakeQuery([
        {
          type: "assistant",
          session_id: "session-1",
          parent_tool_use_id: null,
          uuid: "assistant-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
          },
        } as unknown as SDKMessage,
        {
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
        } as unknown as SDKMessage,
      ]);
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
      void collectPromptMessages(prompt).then((messages) => {
        capturedPromptMessages = messages;
        resolveCapturedPromptMessages(messages);
      });
      return makeFakeQuery([
        {
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
        } as unknown as SDKMessage,
      ]);
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
    createQuery: ({ options }) => {
      const canUseTool = options.canUseTool as CanUseTool | undefined;
      const iterator = (async function* () {
        if (!canUseTool) {
          throw new Error("Expected Claude canUseTool callback");
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

        yield {
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
        } as unknown as SDKMessage;
      })();

      return Object.assign(iterator, makeFakeQuery([]));
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
    createQuery: ({ options }) => {
      capturedOptions = options;
      const canUseTool = options.canUseTool as CanUseTool | undefined;
      const iterator = (async function* () {
        if (!canUseTool) {
          throw new Error("Expected Claude canUseTool callback");
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

        yield {
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
        } as unknown as SDKMessage;
      })();

      return Object.assign(iterator, makeFakeQuery([]));
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
    createQuery: ({ options }) => {
      const canUseTool = options.canUseTool as CanUseTool | undefined;
      const iterator = (async function* () {
        if (!canUseTool) {
          throw new Error("Expected Claude canUseTool callback");
        }

        const permissionResult = await canUseTool(
          "Bash",
          { command: "pwd" },
          { signal: new AbortController().signal, toolUseID: "tool-use-local-proxy-2" },
        );
        capturedPermissionResult = permissionResult;
        resolveCapturedPermissionResult(permissionResult);

        yield {
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
        } as unknown as SDKMessage;
      })();

      return Object.assign(iterator, makeFakeQuery([]));
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
