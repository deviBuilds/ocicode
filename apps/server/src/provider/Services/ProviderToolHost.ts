import type { ThreadId } from "@ocicode/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProviderToolHostError } from "../Errors.ts";

export interface ProviderToolHostOpenSessionResult {
  readonly token: string;
}

export interface ProviderToolHostShape {
  readonly openSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderToolHostOpenSessionResult, ProviderToolHostError>;
  readonly closeSession: (threadId: ThreadId) => Effect.Effect<void, never>;
  readonly resolveThreadId: (token: string) => Effect.Effect<Option.Option<ThreadId>, never>;
  readonly callTool: (input: {
    readonly threadId: ThreadId;
    readonly cwd?: string;
    readonly toolName: string;
    readonly args: unknown;
  }) => Effect.Effect<unknown, ProviderToolHostError>;
}

export class ProviderToolHost extends ServiceMap.Service<ProviderToolHost, ProviderToolHostShape>()(
  "ocicode/provider/Services/ProviderToolHost",
) {}
