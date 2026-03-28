/**
 * ProviderHealthLive - Startup-time provider health checks.
 *
 * Performs one-time provider readiness probes when the server starts and
 * keeps the resulting snapshot in memory for `server.getConfig`.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import * as OS from "node:os";
import type {
  ProviderBridgeHealthInput,
  ProviderExecutionMode,
  ServerProviderAuthStatus,
  ServerProviderStatus,
  ServerProviderStatusState,
} from "@ocicode/contracts";
import { Array, Effect, Fiber, FileSystem, Layer, Option, Path, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config";
import { remoteProviderBridgeCheckHealth } from "../remoteBridgeClient";
import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";

const DEFAULT_TIMEOUT_MS = 4_000;
const CODEX_PROVIDER = "codex" as const;
const CLAUDE_PROVIDER = "claudeAgent" as const;

// ── Pure helpers ────────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

interface CodexCommandOptions {
  readonly binaryPath?: string;
  readonly homePath?: string;
}

interface ClaudeCommandOptions {
  readonly binaryPath?: string;
}

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isCommandMissingCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes("command not found: codex") ||
    lower.includes("spawn codex enoent") ||
    lower.includes("enoent") ||
    lower.includes("notfound")
  );
}

function isClaudeCommandMissingCause(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return (
    lower.includes("command not found: claude") ||
    lower.includes("spawn claude enoent") ||
    lower.includes("enoent") ||
    lower.includes("notfound")
  );
}

function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

function extractAuthBoolean(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);

export const readCodexConfigModelProvider = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const codexHome = process.env.CODEX_HOME || path.join(OS.homedir(), ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const content = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));

  if (content === undefined) {
    return undefined;
  }

  let inTopLevel = true;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("[")) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) {
      continue;
    }

    const match = trimmed.match(/^model_provider\s*=\s*["']([^"']+)["']/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
});

export const hasCustomModelProvider = Effect.map(
  readCodexConfigModelProvider,
  (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
);

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

const runCodexCommand = (args: ReadonlyArray<string>, options?: CodexCommandOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(options?.binaryPath ?? "codex", [...args], {
      shell: process.platform === "win32",
      ...(options?.homePath ? { env: { ...process.env, CODEX_HOME: options.homePath } } : {}),
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runClaudeCommand = (args: ReadonlyArray<string>, options?: ClaudeCommandOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(options?.binaryPath ?? "claude", [...args], {
      shell: process.platform === "win32",
    });

    const child = yield* spawner.spawn(command);

    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

// ── Health check ────────────────────────────────────────────────────

export const checkCodexProviderStatus = (
  options?: CodexCommandOptions & { readonly executionMode?: ProviderExecutionMode },
) =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();

    // Probe 1: `codex --version` — is the CLI reachable?
    const versionProbe = yield* runCodexCommand(["--version"], options).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isCommandMissingCause(error)
          ? "Codex CLI (`codex`) is not installed or not on PATH."
          : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: CODEX_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Codex CLI is installed but failed to run. Timed out while running command.",
      };
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: CODEX_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Codex CLI is installed but failed to run. ${detail}`
          : "Codex CLI is installed but failed to run.",
      };
    }

    const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
    if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
      return {
        provider: CODEX_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: formatCodexCliUpgradeMessage(parsedVersion),
      };
    }

    if (yield* hasCustomModelProvider) {
      return {
        provider: CODEX_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "ready" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Using a custom Codex model provider; OpenAI login check skipped.",
      } satisfies ServerProviderStatus;
    }

    const authProbe = yield* runCodexCommand(["login", "status"], options).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CODEX_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Codex authentication status: ${error.message}.`
            : "Could not verify Codex authentication status.",
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CODEX_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Could not verify Codex authentication status. Timed out while running command.",
      };
    }

    const parsed = parseAuthStatusFromOutput(authProbe.success.value);
    return {
      provider: CODEX_PROVIDER,
      executionMode: options?.executionMode ?? "local",
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export function parseClaudeAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Claude Agent authentication status command is unavailable in this Claude version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `claude auth login`") ||
    lowerOutput.includes("run claude auth login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
    try {
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(JSON.parse(trimmed)),
      };
    } catch {
      return { attemptedJsonParse: false as const, auth: undefined as boolean | undefined };
    }
  })();

  if (parsedAuth.auth === true) {
    return { status: "ready", authStatus: "authenticated" };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Claude authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    return { status: "ready", authStatus: "authenticated" };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
  };
}

export const checkClaudeProviderStatus = (
  options?: ClaudeCommandOptions & { readonly executionMode?: ProviderExecutionMode },
) =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();

    const versionProbe = yield* runClaudeCommand(["--version"], options).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: CLAUDE_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: isClaudeCommandMissingCause(error)
          ? "Claude CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: CLAUDE_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Claude CLI is installed but failed to run. Timed out while running command.",
      };
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: CLAUDE_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Claude CLI is installed but failed to run. ${detail}`
          : "Claude CLI is installed but failed to run.",
      };
    }

    const authProbe = yield* runClaudeCommand(["auth", "status"], options).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CLAUDE_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Claude authentication status: ${error.message}.`
            : "Could not verify Claude authentication status.",
      };
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CLAUDE_PROVIDER,
        executionMode: options?.executionMode ?? "local",
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Could not verify Claude authentication status. Timed out while running command.",
      };
    }

    const parsed = parseClaudeAuthStatusFromOutput(authProbe.success.value);
    return {
      provider: CLAUDE_PROVIDER,
      executionMode: options?.executionMode ?? "local",
      status: parsed.status,
      available: true,
      authStatus: parsed.authStatus,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

function disabledProviderStatus(input: {
  provider: typeof CODEX_PROVIDER | typeof CLAUDE_PROVIDER;
  message: string;
}): ServerProviderStatus {
  return {
    provider: input.provider,
    executionMode: "disabled",
    status: "warning",
    available: false,
    authStatus: "unknown",
    checkedAt: new Date().toISOString(),
    message: input.message,
  };
}

function remoteBridgeMissingStatus(input: {
  provider: typeof CODEX_PROVIDER | typeof CLAUDE_PROVIDER;
  message: string;
}): ServerProviderStatus {
  return {
    provider: input.provider,
    executionMode: "remote",
    status: "error",
    available: false,
    authStatus: "unknown",
    checkedAt: new Date().toISOString(),
    message: input.message,
  };
}

function localUnavailableStatus(input: {
  provider: typeof CODEX_PROVIDER | typeof CLAUDE_PROVIDER;
  message: string;
}): ServerProviderStatus {
  return {
    provider: input.provider,
    executionMode: "local",
    status: "error",
    available: false,
    authStatus: "unknown",
    checkedAt: new Date().toISOString(),
    message: input.message,
  };
}

const resolveExecutionMode = (input: ProviderBridgeHealthInput): ProviderExecutionMode => {
  if (input.provider === "claudeAgent") {
    return input.providerOptions?.claudeAgent?.executionMode ?? "local";
  }
  return input.providerOptions?.codex?.executionMode ?? "local";
};

const resolveRemoteBridgeInput = (
  input: ProviderBridgeHealthInput,
): { baseUrl: string; sharedSecret: string } | null => {
  const remote =
    input.provider === "claudeAgent"
      ? input.providerOptions?.claudeAgent?.remote
      : input.providerOptions?.codex?.remote;
  const baseUrl = remote?.baseUrl?.trim();
  const sharedSecret = remote?.sharedSecret?.trim();
  if (!baseUrl || !sharedSecret) {
    return null;
  }
  return { baseUrl, sharedSecret };
};

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const runCodexHealth = (
      options?: CodexCommandOptions & { readonly executionMode?: ProviderExecutionMode },
    ) =>
      checkCodexProviderStatus(options).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
    const runClaudeHealth = (
      options?: ClaudeCommandOptions & { readonly executionMode?: ProviderExecutionMode },
    ) =>
      checkClaudeProviderStatus(options).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );

    const checkStatus: ProviderHealthShape["checkStatus"] = (input) =>
      Effect.gen(function* () {
        const provider = input.provider ?? CODEX_PROVIDER;
        const executionMode = resolveExecutionMode({
          ...input,
          provider,
        });

        if (executionMode === "disabled") {
          return disabledProviderStatus({
            provider,
            message: `${provider === CODEX_PROVIDER ? "Codex" : "Claude"} is disabled in settings.`,
          });
        }

        if (executionMode === "remote") {
          if (!serverConfig.enableRemoteProviderMode) {
            return remoteBridgeMissingStatus({
              provider,
              message: "Remote provider mode is disabled in this build.",
            });
          }
          const remoteBridge = resolveRemoteBridgeInput({
            ...input,
            provider,
          });
          if (!remoteBridge) {
            return remoteBridgeMissingStatus({
              provider,
              message: "Remote bridge URL and shared secret are required for remote mode.",
            });
          }
          return yield* remoteProviderBridgeCheckHealth({
            ...remoteBridge,
            payload: {
              provider,
              providerOptions:
                provider === CLAUDE_PROVIDER
                  ? {
                      claudeAgent: {
                        executionMode: "local",
                        ...(input.providerOptions?.claudeAgent?.binaryPath
                          ? { binaryPath: input.providerOptions.claudeAgent.binaryPath }
                          : {}),
                      },
                    }
                  : {
                      codex: {
                        executionMode: "local",
                        ...(input.providerOptions?.codex?.binaryPath
                          ? { binaryPath: input.providerOptions.codex.binaryPath }
                          : {}),
                        ...(input.providerOptions?.codex?.homePath
                          ? { homePath: input.providerOptions.codex.homePath }
                          : {}),
                      },
                    },
            },
          }).pipe(
            Effect.map((status) => ({
              ...status,
              executionMode: "remote" as const,
            })),
            Effect.orElseSucceed(() =>
              remoteBridgeMissingStatus({
                provider,
                message: "Remote provider bridge is unreachable.",
              }),
            ),
          );
        }

        if (provider === CODEX_PROVIDER) {
          return yield* runCodexHealth({
            executionMode: "local",
            ...(input.providerOptions?.codex?.binaryPath
              ? { binaryPath: input.providerOptions.codex.binaryPath }
              : {}),
            ...(input.providerOptions?.codex?.homePath
              ? { homePath: input.providerOptions.codex.homePath }
              : {}),
          });
        }

        if (!serverConfig.enableClaudeProvider) {
          return localUnavailableStatus({
            provider,
            message: "Claude support is disabled in this build.",
          });
        }

        return yield* runClaudeHealth({
          executionMode: "local",
          ...(input.providerOptions?.claudeAgent?.binaryPath
            ? { binaryPath: input.providerOptions.claudeAgent.binaryPath }
            : {}),
        });
      });

    const statusChecks: Array<Effect.Effect<ServerProviderStatus>> = [
      runCodexHealth({ executionMode: "local" }),
    ];
    if (serverConfig.enableClaudeProvider) {
      statusChecks.push(runClaudeHealth({ executionMode: "local" }));
    }

    const providerStatusesFiber = yield* Effect.all(statusChecks).pipe(Effect.forkScoped);

    return {
      getStatuses: Fiber.join(providerStatusesFiber),
      checkStatus,
    } satisfies ProviderHealthShape;
  }),
);
