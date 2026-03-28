import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  PROVIDER_BRIDGE_CHANNELS,
  PROVIDER_BRIDGE_METHODS,
  PROVIDER_BRIDGE_WS_PATH,
  type ProviderBridgeHealthInput,
  ProviderBridgeHealthResult,
  ProviderBridgeMessage,
  type ProviderBridgeResolveToolHostRequestInput,
  ProviderBridgeReadThreadInput,
  ProviderBridgeRequest,
  ProviderBridgeToolHostRequestPayload,
  ProviderBridgeThreadSnapshot,
  type ProviderRuntimeEvent,
  ProviderRuntimeEvent as ProviderRuntimeEventSchema,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@ocicode/contracts";
import { Effect, Schema } from "effect";
import WebSocket from "ws";

class RemoteProviderBridgeClientError extends Schema.TaggedErrorClass<RemoteProviderBridgeClientError>()(
  "RemoteProviderBridgeClientError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

type BridgePendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type ToolRequestHandlerResult =
  | { handled: true; result?: unknown; error?: string }
  | { handled: false };

type ToolRequestHandler = (
  request: typeof ProviderBridgeToolHostRequestPayload.Type,
) => Promise<ToolRequestHandlerResult>;

const REMOTE_PROVIDER_BRIDGE_CONNECT_TIMEOUT_MS = 10_000;

function websocketRawToString(raw: WebSocket.RawData): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  return null;
}

function toBridgeUrl(baseUrl: string, sharedSecret: string): string {
  const url = new URL(baseUrl);
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  url.pathname = PROVIDER_BRIDGE_WS_PATH;
  url.searchParams.set("secret", sharedSecret);
  return url.toString();
}

function formatUnexpectedBridgeUpgrade(response: IncomingMessage): string {
  const statusCode = response.statusCode ?? "unknown";
  const statusMessage = response.statusMessage?.trim();
  const location = response.headers.location?.trim();
  const suffix = [
    statusMessage && statusMessage.length > 0 ? statusMessage : undefined,
    location && location.length > 0 ? `Location: ${location}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  return suffix.length > 0
    ? `Remote provider bridge rejected websocket upgrade (${statusCode}: ${suffix}).`
    : `Remote provider bridge rejected websocket upgrade (${statusCode}).`;
}

class RemoteProviderBridgeClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<WebSocket> | null = null;
  private readonly pending = new Map<string, BridgePendingRequest>();
  private readonly listeners = new Set<(event: ProviderRuntimeEvent) => void>();
  private readonly toolRequestHandlers = new Set<ToolRequestHandler>();

  constructor(
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
  ) {}

  private decodeWithSchema<T>(decode: (input: unknown) => T, input: unknown): T {
    try {
      return decode(input);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Failed to decode bridge payload.", {
        cause: error,
      });
    }
  }

  private async respondToToolRequest(
    payload: typeof ProviderBridgeToolHostRequestPayload.Type,
    response:
      | { handled: true; result?: unknown; error?: string }
      | { handled: false; error?: string },
  ): Promise<void> {
    const body: ProviderBridgeResolveToolHostRequestInput = {
      requestId: payload.requestId,
      threadId: payload.threadId,
      ...(response.handled && response.result !== undefined ? { result: response.result } : {}),
      ...(!response.handled || response.error
        ? {
            error: {
              message: response.error ?? "No local workspace handler accepted the tool request.",
            },
          }
        : {}),
    };

    await this.request(
      PROVIDER_BRIDGE_METHODS.resolveToolHostRequest,
      body as unknown as Record<string, unknown>,
      Schema.decodeUnknownSync(Schema.Unknown),
    );
  }

  private async handleToolRequestPush(data: unknown): Promise<void> {
    let payload: typeof ProviderBridgeToolHostRequestPayload.Type;
    try {
      payload = this.decodeWithSchema(
        Schema.decodeUnknownSync(ProviderBridgeToolHostRequestPayload),
        data,
      );
    } catch (error) {
      console.warn("Dropped provider bridge tool request", {
        issue: error instanceof Error ? error.message : "Failed to decode bridge payload.",
      });
      return;
    }

    for (const handler of this.toolRequestHandlers) {
      try {
        const response = await handler(payload);
        if (!response.handled) {
          continue;
        }
        await this.respondToToolRequest(payload, response);
        return;
      } catch (error) {
        await this.respondToToolRequest(payload, {
          handled: true,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    await this.respondToToolRequest(payload, { handled: false });
  }

  private handleSocketMessage(raw: WebSocket.RawData): void {
    const text = websocketRawToString(raw);
    if (!text) {
      return;
    }
    let message: typeof ProviderBridgeMessage.Type;
    try {
      message = this.decodeWithSchema(
        Schema.decodeUnknownSync(Schema.fromJsonString(ProviderBridgeMessage)),
        text,
      );
    } catch (error) {
      console.warn("Dropped provider bridge message", {
        issue: error instanceof Error ? error.message : "Failed to decode bridge payload.",
      });
      return;
    }
    if ("type" in message) {
      if (message.channel === PROVIDER_BRIDGE_CHANNELS.providerEvent) {
        let event: ProviderRuntimeEvent;
        try {
          event = this.decodeWithSchema(
            Schema.decodeUnknownSync(ProviderRuntimeEventSchema),
            message.data,
          );
        } catch (error) {
          console.warn("Dropped provider bridge event", {
            issue: error instanceof Error ? error.message : "Failed to decode bridge payload.",
          });
          return;
        }
        for (const listener of this.listeners) {
          listener(event);
        }
        return;
      }
      if (message.channel === PROVIDER_BRIDGE_CHANNELS.toolHostRequest) {
        void this.handleToolRequestPush(message.data).catch((error) => {
          console.warn("Failed to handle provider bridge tool request", {
            issue: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error?.message) {
      pending.reject(new Error(message.error.message));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async ensureConnected(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.socket;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const url = toBridgeUrl(this.baseUrl, this.sharedSecret);
    this.connectPromise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timeout = setTimeout(() => {
        cleanup();
        try {
          socket.terminate();
        } catch {
          // ignore termination failures while timing out
        }
        reject(
          new Error(
            `Timed out connecting to remote provider bridge after ${REMOTE_PROVIDER_BRIDGE_CONNECT_TIMEOUT_MS}ms.`,
          ),
        );
      }, REMOTE_PROVIDER_BRIDGE_CONNECT_TIMEOUT_MS);
      const onOpen = () => {
        cleanup();
        this.socket = socket;
        socket.on("message", (raw) => this.handleSocketMessage(raw));
        socket.on("close", () => {
          this.socket = null;
          this.rejectAllPending(new Error("Remote provider bridge connection closed."));
        });
        socket.on("error", (error) => {
          this.socket = null;
          this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
        });
        resolve(socket);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onUnexpectedResponse = (_request: unknown, response: IncomingMessage) => {
        cleanup();
        try {
          socket.close();
        } catch {
          // ignore close failures while rejecting unexpected upgrades
        }
        reject(new Error(formatUnexpectedBridgeUpgrade(response)));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("unexpected-response", onUnexpectedResponse);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("unexpected-response", onUnexpectedResponse);
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  subscribe(listener: (event: ProviderRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeToolRequests(handler: ToolRequestHandler): () => void {
    this.toolRequestHandlers.add(handler);
    return () => {
      this.toolRequestHandlers.delete(handler);
    };
  }

  async request<T>(
    method: string,
    payload: Record<string, unknown>,
    decode: (input: unknown) => T,
  ): Promise<T> {
    const socket = await this.ensureConnected();
    const requestId = crypto.randomUUID();
    const request = {
      id: requestId,
      body: {
        _tag: method,
        ...payload,
      },
    };
    const encoded = JSON.stringify(
      Schema.encodeSync(ProviderBridgeRequest)(request as typeof ProviderBridgeRequest.Type),
    );
    const response = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      socket.send(encoded, (error) => {
        if (!error) {
          return;
        }
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return this.decodeWithSchema(decode, response);
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.rejectAllPending(new Error("Remote provider bridge connection closed."));
  }
}

const bridgeClientCache = new Map<string, RemoteProviderBridgeClient>();

function bridgeClientKey(baseUrl: string, sharedSecret: string): string {
  return `${baseUrl}\n${sharedSecret}`;
}

export function getRemoteProviderBridgeClient(input: {
  baseUrl: string;
  sharedSecret: string;
}): RemoteProviderBridgeClient {
  const key = bridgeClientKey(input.baseUrl, input.sharedSecret);
  const existing = bridgeClientCache.get(key);
  if (existing) {
    return existing;
  }
  const created = new RemoteProviderBridgeClient(input.baseUrl, input.sharedSecret);
  bridgeClientCache.set(key, created);
  return created;
}

export function closeAllRemoteProviderBridgeClients(): void {
  for (const client of bridgeClientCache.values()) {
    client.close();
  }
  bridgeClientCache.clear();
}

export const remoteProviderBridgeRequest = <T>(input: {
  baseUrl: string;
  sharedSecret: string;
  method: string;
  payload: Record<string, unknown>;
  decode: (input: unknown) => T;
}) =>
  Effect.tryPromise({
    try: () =>
      getRemoteProviderBridgeClient({
        baseUrl: input.baseUrl,
        sharedSecret: input.sharedSecret,
      }).request(input.method, input.payload, input.decode),
    catch: (cause) =>
      new RemoteProviderBridgeClientError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

export const remoteProviderBridgeStartSession = (input: {
  baseUrl: string;
  sharedSecret: string;
  payload: ProviderSessionStartInput;
}) =>
  remoteProviderBridgeRequest({
    baseUrl: input.baseUrl,
    sharedSecret: input.sharedSecret,
    method: PROVIDER_BRIDGE_METHODS.startSession,
    payload: input.payload as unknown as Record<string, unknown>,
    decode: Schema.decodeUnknownSync(ProviderSession),
  });

export const remoteProviderBridgeSendTurn = (input: {
  baseUrl: string;
  sharedSecret: string;
  payload: ProviderSendTurnInput;
}) =>
  remoteProviderBridgeRequest({
    baseUrl: input.baseUrl,
    sharedSecret: input.sharedSecret,
    method: PROVIDER_BRIDGE_METHODS.sendTurn,
    payload: input.payload as unknown as Record<string, unknown>,
    decode: Schema.decodeUnknownSync(ProviderTurnStartResult),
  });

export const remoteProviderBridgeReadThread = (input: {
  baseUrl: string;
  sharedSecret: string;
  payload: ProviderBridgeReadThreadInput;
}) =>
  remoteProviderBridgeRequest({
    baseUrl: input.baseUrl,
    sharedSecret: input.sharedSecret,
    method: PROVIDER_BRIDGE_METHODS.readThread,
    payload: input.payload as unknown as Record<string, unknown>,
    decode: Schema.decodeUnknownSync(ProviderBridgeThreadSnapshot),
  });

export const remoteProviderBridgeCheckHealth = (input: {
  baseUrl: string;
  sharedSecret: string;
  payload: ProviderBridgeHealthInput;
}) =>
  remoteProviderBridgeRequest({
    baseUrl: input.baseUrl,
    sharedSecret: input.sharedSecret,
    method: PROVIDER_BRIDGE_METHODS.checkHealth,
    payload: input.payload as unknown as Record<string, unknown>,
    decode: Schema.decodeUnknownSync(ProviderBridgeHealthResult),
  });
