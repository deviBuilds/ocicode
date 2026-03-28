import type { AddressInfo } from "node:net";

import {
  PROVIDER_BRIDGE_METHODS,
  PROVIDER_BRIDGE_WS_PATH,
  ProviderBridgeRequest,
  ThreadId,
} from "@ocicode/contracts";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  closeAllRemoteProviderBridgeClients,
  remoteProviderBridgeSendTurn,
} from "./remoteBridgeClient";

describe("remoteProviderBridgeSendTurn", () => {
  const servers = new Set<WebSocketServer>();

  afterEach(async () => {
    closeAllRemoteProviderBridgeClients();

    await Promise.all(
      [...servers].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      ),
    );
    servers.clear();
  });

  it("preserves Claude modelOptions across the remote bridge request", async () => {
    let capturedRequest: { id: string; body: unknown } | null = null;
    let capturedUrl: string | undefined;

    const server = new WebSocketServer({ port: 0 });
    servers.add(server);

    server.on("connection", (socket: WebSocket, request) => {
      capturedUrl = request.url ?? undefined;

      socket.on("message", (raw) => {
        const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderBridgeRequest))(
          String(raw),
        );
        capturedRequest = { id: decoded.id, body: decoded.body };

        socket.send(
          JSON.stringify({
            id: capturedRequest.id,
            result: {
              threadId: "thread-claude-remote-1",
              turnId: "turn-claude-remote-1",
            },
          }),
        );
      });
    });

    const address = server.address() as AddressInfo;
    const result = await Effect.runPromise(
      remoteProviderBridgeSendTurn({
        baseUrl: `http://127.0.0.1:${address.port}`,
        sharedSecret: "bridge-secret",
        payload: {
          threadId: ThreadId.makeUnsafe("thread-claude-remote-1"),
          input: "Review this diff",
          model: "claude-sonnet-4-6",
          attachments: [],
          modelOptions: {
            claudeAgent: {
              effort: "ultrathink",
              thinking: true,
              contextWindow: "1m",
            },
          },
        },
      }),
    );

    expect(result).toEqual({
      threadId: "thread-claude-remote-1",
      turnId: "turn-claude-remote-1",
    });
    expect(capturedUrl).toBe(`${PROVIDER_BRIDGE_WS_PATH}?secret=bridge-secret`);
    const capturedBody = (capturedRequest as { body: unknown } | null)?.body ?? null;
    expect(capturedBody).toMatchObject({
      _tag: PROVIDER_BRIDGE_METHODS.sendTurn,
      threadId: "thread-claude-remote-1",
      input: "Review this diff",
      model: "claude-sonnet-4-6",
      attachments: [],
      modelOptions: {
        claudeAgent: {
          effort: "ultrathink",
          thinking: true,
          contextWindow: "1m",
        },
      },
    });
  });
});
