import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Path as EffectPath } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { ServerConfig } from "./config";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { ProviderUnsupportedError } from "./provider/Errors";
import { makeClaudeAdapterLive } from "./provider/Layers/ClaudeAdapter";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderToolHostLive } from "./provider/Layers/ProviderToolHost";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderToolHost } from "./provider/Services/ProviderToolHost";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";

import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { KeybindingsLive } from "./keybindings";
import { GitManagerLive } from "./git/Layers/GitManager";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { CodexTextGenerationLive } from "./git/Layers/CodexTextGeneration";
import { GitServiceLive } from "./git/Layers/GitService";
import { PtyAdapter } from "./terminal/Services/PTY";

type RuntimePtyAdapterLoader = {
  layer: Layer.Layer<PtyAdapter, never, FileSystem.FileSystem | EffectPath.Path>;
};

const runtimePtyAdapterLoaders = {
  bun: () => import("./terminal/Layers/BunPTY"),
  node: () => import("./terminal/Layers/NodePTY"),
} satisfies Record<string, () => Promise<RuntimePtyAdapterLoader>>;

const makeRuntimePtyAdapterLayer = () =>
  Effect.gen(function* () {
    const runtime = process.versions.bun !== undefined ? "bun" : "node";
    const loader = runtimePtyAdapterLoaders[runtime];
    const ptyAdapterModule = yield* Effect.promise<RuntimePtyAdapterLoader>(loader);
    return ptyAdapterModule.layer;
  }).pipe(Layer.unwrap);

export function makeServerProviderLayer(): Layer.Layer<
  ProviderService | ProviderToolHost,
  ProviderUnsupportedError,
  SqlClient.SqlClient | ServerConfig | FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const providerLogsDir = path.join(stateDir, "logs", "provider");
    const providerEventLogPath = path.join(providerLogsDir, "events.log");
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const providerToolHostLayer = ProviderToolHostLive;
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const claudeAdapterLayer = makeClaudeAdapterLive();
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provideMerge(providerToolHostLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerServiceLayer = makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provide(providerSessionDirectoryLayer),
      Layer.provide(providerToolHostLayer),
    );

    return Layer.mergeAll(providerServiceLayer, providerToolHostLayer);
  }).pipe(Layer.unwrap);
}

export function makeServerRuntimeServicesLayer() {
  const gitCoreLayer = GitCoreLive.pipe(Layer.provideMerge(GitServiceLive));
  const textGenerationLayer = CodexTextGenerationLive;

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(CheckpointStoreLive),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    orchestrationLayer,
    OrchestrationProjectionSnapshotQueryLive,
    CheckpointStoreLive,
    checkpointDiffQueryLayer,
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(gitCoreLayer),
    Layer.provideMerge(textGenerationLayer),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
  );

  const terminalLayer = TerminalManagerLive.pipe(Layer.provide(makeRuntimePtyAdapterLayer()));

  const gitManagerLayer = GitManagerLive.pipe(
    Layer.provideMerge(gitCoreLayer),
    Layer.provideMerge(GitHubCliLive),
    Layer.provideMerge(textGenerationLayer),
  );

  return Layer.mergeAll(
    orchestrationReactorLayer,
    gitCoreLayer,
    gitManagerLayer,
    terminalLayer,
    KeybindingsLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}
