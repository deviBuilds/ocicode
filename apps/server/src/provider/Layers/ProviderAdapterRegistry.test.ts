import type { ProviderKind } from "@ocicode/contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Layer, Stream } from "effect";

import { ClaudeAdapter, ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter, CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import {
  makeProviderAdapterRegistryLive,
  ProviderAdapterRegistryLive,
} from "./ProviderAdapterRegistry.ts";
import { ProviderUnsupportedError } from "../Errors.ts";

const fakeCodexAdapter: CodexAdapterShape = {
  provider: "codex",
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeClaudeAdapter: ClaudeAdapterShape = {
  provider: "claudeAgent",
  capabilities: { sessionModelSwitch: "restart-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const layer = it.layer(
  Layer.provide(
    ProviderAdapterRegistryLive,
    Layer.mergeAll(
      Layer.succeed(CodexAdapter, fakeCodexAdapter),
      Layer.succeed(ClaudeAdapter, fakeClaudeAdapter),
    ),
  ),
);

const codexOnlyLayer = it.layer(
  Layer.provide(
    makeProviderAdapterRegistryLive({ includeClaudeAdapter: false }),
    Layer.succeed(CodexAdapter, fakeCodexAdapter),
  ),
);

layer("ProviderAdapterRegistryLive", (it) => {
  it.effect("resolves a registered provider adapter", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const codex = yield* registry.getByProvider("codex");
      assert.equal(codex, fakeCodexAdapter);

      const providers = yield* registry.listProviders();
      assert.deepEqual(providers, ["codex", "claudeAgent"]);
    }),
  );

  it.effect("fails with ProviderUnsupportedError for unknown providers", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider("unknown" as ProviderKind).pipe(Effect.result);
      assertFailure(adapter, new ProviderUnsupportedError({ provider: "unknown" }));
    }),
  );
});

codexOnlyLayer("ProviderAdapterRegistryLive codex-only", (it) => {
  it.effect("does not register Claude when the provider gate is off", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry;
      const providers = yield* registry.listProviders();
      assert.deepEqual(providers, ["codex"]);

      const claude = yield* registry.getByProvider("claudeAgent").pipe(Effect.result);
      assertFailure(claude, new ProviderUnsupportedError({ provider: "claudeAgent" }));
    }),
  );
});
