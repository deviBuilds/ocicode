import { Schema, Struct } from "effect";
import { ThreadId, TrimmedNonEmptyString, TurnId } from "./baseSchemas";
import {
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStartOptions,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
} from "./provider";
import { ProviderRuntimeEvent } from "./providerRuntime";
import { ProviderKind } from "./orchestration";
import { ServerProviderStatus } from "./server";
import {
  ProviderBridgeResolveToolHostRequestInput,
  ProviderBridgeToolHostRequest,
} from "./providerToolHost";

export const PROVIDER_BRIDGE_WS_PATH = "/provider-bridge";

export const PROVIDER_BRIDGE_METHODS = {
  startSession: "providerBridge.startSession",
  sendTurn: "providerBridge.sendTurn",
  interruptTurn: "providerBridge.interruptTurn",
  respondToRequest: "providerBridge.respondToRequest",
  respondToUserInput: "providerBridge.respondToUserInput",
  stopSession: "providerBridge.stopSession",
  readThread: "providerBridge.readThread",
  rollbackThread: "providerBridge.rollbackThread",
  checkHealth: "providerBridge.checkHealth",
  resolveToolHostRequest: "providerBridge.resolveToolHostRequest",
} as const;

export const PROVIDER_BRIDGE_CHANNELS = {
  providerEvent: "providerBridge.providerEvent",
  toolHostRequest: "providerBridge.toolHostRequest",
} as const;

export const ProviderBridgeReadThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderBridgeReadThreadInput = typeof ProviderBridgeReadThreadInput.Type;

export const ProviderBridgeRollbackThreadInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: Schema.Int,
});
export type ProviderBridgeRollbackThreadInput = typeof ProviderBridgeRollbackThreadInput.Type;

export const ProviderBridgeThreadTurnSnapshot = Schema.Struct({
  id: TurnId,
  items: Schema.Array(Schema.Unknown),
});
export type ProviderBridgeThreadTurnSnapshot = typeof ProviderBridgeThreadTurnSnapshot.Type;

export const ProviderBridgeThreadSnapshot = Schema.Struct({
  threadId: ThreadId,
  turns: Schema.Array(ProviderBridgeThreadTurnSnapshot),
});
export type ProviderBridgeThreadSnapshot = typeof ProviderBridgeThreadSnapshot.Type;

export const ProviderBridgeHealthInput = Schema.Struct({
  provider: Schema.optional(ProviderKind),
  providerOptions: Schema.optional(ProviderStartOptions),
});
export type ProviderBridgeHealthInput = typeof ProviderBridgeHealthInput.Type;

const tagRequestBody = <const Tag extends string, const Fields extends Schema.Struct.Fields>(
  tag: Tag,
  schema: Schema.Struct<Fields>,
) =>
  schema.mapFields(Struct.assign({ _tag: Schema.tag(tag) }), {
    unsafePreserveChecks: true,
  });

export const ProviderBridgeRequestBody = Schema.Union([
  tagRequestBody(PROVIDER_BRIDGE_METHODS.startSession, ProviderSessionStartInput),
  tagRequestBody(PROVIDER_BRIDGE_METHODS.sendTurn, ProviderSendTurnInput),
  tagRequestBody(PROVIDER_BRIDGE_METHODS.interruptTurn, ProviderInterruptTurnInput),
  tagRequestBody(PROVIDER_BRIDGE_METHODS.respondToRequest, ProviderRespondToRequestInput),
  tagRequestBody(PROVIDER_BRIDGE_METHODS.respondToUserInput, ProviderRespondToUserInputInput),
  tagRequestBody(PROVIDER_BRIDGE_METHODS.stopSession, ProviderStopSessionInput),
  tagRequestBody(PROVIDER_BRIDGE_METHODS.readThread, ProviderBridgeReadThreadInput),
  tagRequestBody(PROVIDER_BRIDGE_METHODS.rollbackThread, ProviderBridgeRollbackThreadInput),
  tagRequestBody(PROVIDER_BRIDGE_METHODS.checkHealth, ProviderBridgeHealthInput),
  tagRequestBody(
    PROVIDER_BRIDGE_METHODS.resolveToolHostRequest,
    ProviderBridgeResolveToolHostRequestInput,
  ),
]);
export type ProviderBridgeRequestBody = typeof ProviderBridgeRequestBody.Type;

export const ProviderBridgeRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  body: ProviderBridgeRequestBody,
});
export type ProviderBridgeRequest = typeof ProviderBridgeRequest.Type;

export const ProviderBridgeResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
    }),
  ),
});
export type ProviderBridgeResponse = typeof ProviderBridgeResponse.Type;

export const ProviderBridgePush = Schema.Struct({
  type: Schema.Literal("push"),
  channel: TrimmedNonEmptyString,
  data: Schema.Unknown,
});
export type ProviderBridgePush = typeof ProviderBridgePush.Type;

export const ProviderBridgeMessage = Schema.Union([ProviderBridgeResponse, ProviderBridgePush]);
export type ProviderBridgeMessage = typeof ProviderBridgeMessage.Type;

export const ProviderBridgeStartSessionResult = ProviderSession;
export type ProviderBridgeStartSessionResult = typeof ProviderBridgeStartSessionResult.Type;

export const ProviderBridgeSendTurnResult = ProviderTurnStartResult;
export type ProviderBridgeSendTurnResult = typeof ProviderBridgeSendTurnResult.Type;

export const ProviderBridgeHealthResult = ServerProviderStatus;
export type ProviderBridgeHealthResult = typeof ProviderBridgeHealthResult.Type;

export const ProviderBridgeEventPayload = ProviderRuntimeEvent;
export type ProviderBridgeEventPayload = typeof ProviderBridgeEventPayload.Type;

export const ProviderBridgeToolHostRequestPayload = ProviderBridgeToolHostRequest;
export type ProviderBridgeToolHostRequestPayload = typeof ProviderBridgeToolHostRequestPayload.Type;
