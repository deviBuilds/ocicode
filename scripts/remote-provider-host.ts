#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3773;

export type RemoteProviderHostMode = "dev" | "start";

export interface RemoteProviderHostOptions {
  readonly host: string;
  readonly port: number;
  readonly advertiseHost?: string;
  readonly stateDir?: string;
  readonly authToken?: string;
  readonly bridgeSecret: string;
  readonly bridgeSecretGenerated: boolean;
  readonly enableClaudeProvider: boolean;
  readonly mode: RemoteProviderHostMode;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

export function parseRemoteProviderHostArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RemoteProviderHostOptions {
  let host = env.OCICODE_HOST?.trim() || DEFAULT_HOST;
  let port = parsePort(env.OCICODE_PORT, DEFAULT_PORT);
  let advertiseHost: string | undefined;
  let stateDir = env.OCICODE_STATE_DIR?.trim() || undefined;
  let authToken = env.OCICODE_AUTH_TOKEN?.trim() || undefined;
  let bridgeSecret = env.OCICODE_PROVIDER_BRIDGE_SHARED_SECRET?.trim() || undefined;
  let enableClaudeProvider = parseBooleanEnv(env.OCICODE_ENABLE_CLAUDE_PROVIDER);
  let mode: RemoteProviderHostMode = "dev";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--host":
        host = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--port":
        port = parsePort(takeValue(argv, index, arg), DEFAULT_PORT);
        index += 1;
        break;
      case "--advertise-host":
        advertiseHost = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--state-dir":
        stateDir = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--auth-token":
      case "--token":
        authToken = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--secret":
        bridgeSecret = takeValue(argv, index, arg);
        index += 1;
        break;
      case "--claude":
        enableClaudeProvider = true;
        break;
      case "--mode": {
        const candidate = takeValue(argv, index, arg);
        if (candidate !== "dev" && candidate !== "start") {
          throw new Error(`Invalid mode: ${candidate}`);
        }
        mode = candidate;
        index += 1;
        break;
      }
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const resolvedBridgeSecret =
    bridgeSecret && bridgeSecret.length > 0 ? bridgeSecret : randomBytes(24).toString("hex");

  return {
    host,
    port,
    ...(advertiseHost ? { advertiseHost } : {}),
    ...(stateDir ? { stateDir } : {}),
    ...(authToken ? { authToken } : {}),
    bridgeSecret: resolvedBridgeSecret,
    bridgeSecretGenerated: !bridgeSecret,
    enableClaudeProvider,
    mode,
  };
}

export function buildRemoteProviderHostEnv(
  options: RemoteProviderHostOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    OCICODE_MODE: "web",
    OCICODE_HOST: options.host,
    OCICODE_PORT: String(options.port),
    OCICODE_NO_BROWSER: "1",
    OCICODE_ENABLE_REMOTE_PROVIDER_MODE: "1",
    OCICODE_PROVIDER_BRIDGE_SHARED_SECRET: options.bridgeSecret,
  };

  // This helper is for a standalone remote provider host. Inheriting a local
  // web dev URL from another shell session makes `/` redirect to localhost on
  // the provider laptop, which is misleading for remote clients.
  delete env.VITE_DEV_SERVER_URL;

  if (options.enableClaudeProvider) {
    env.OCICODE_ENABLE_CLAUDE_PROVIDER = "1";
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  } else {
    delete env.OCICODE_ENABLE_CLAUDE_PROVIDER;
  }

  if (options.stateDir) {
    env.OCICODE_STATE_DIR = options.stateDir;
  }

  if (options.authToken) {
    env.OCICODE_AUTH_TOKEN = options.authToken;
  }

  return env;
}

export function resolveAdvertisedBaseUrl(options: RemoteProviderHostOptions): string | undefined {
  const host =
    options.advertiseHost ??
    (options.host !== "0.0.0.0" && options.host !== "::" && options.host !== "[::]"
      ? options.host
      : undefined);
  if (!host) {
    return undefined;
  }
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${options.port}`;
}

export function formatRemoteProviderHostSummary(options: RemoteProviderHostOptions): string {
  const advertisedBaseUrl = resolveAdvertisedBaseUrl(options);
  return [
    "Remote provider host configuration",
    `  bind host: ${options.host}`,
    `  port: ${options.port}`,
    `  Claude enabled: ${options.enableClaudeProvider ? "yes" : "no"}`,
    `  launch mode: ${options.mode}`,
    `  bridge secret: ${options.bridgeSecret}${options.bridgeSecretGenerated ? " (generated)" : ""}`,
    advertisedBaseUrl
      ? `  Laptop A remote bridge URL: ${advertisedBaseUrl}`
      : `  Laptop A remote bridge URL: http://<Laptop-B-IP>:${options.port}`,
    "  no reverse access from Laptop B to Laptop A is required",
  ].join("\n");
}

function printHelp(): void {
  console.log(`Usage: bun run remote-provider-host -- [options]

Options:
  --host <host>              Bind host. Defaults to 0.0.0.0.
  --port <port>              Bind port. Defaults to 3773.
  --advertise-host <host>    Hostname/IP to print for Laptop A.
  --secret <secret>          Provider bridge shared secret. Generated when omitted.
  --claude                   Enable Claude provider support.
  --auth-token <token>       Optional UI websocket auth token for this server.
  --state-dir <path>         Optional OCICODE state directory.
  --mode <dev|start>         Launch apps/server in dev or start mode. Defaults to dev.
  --help                     Show this help.
`);
}

export async function runRemoteProviderHost(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const options = parseRemoteProviderHostArgs(argv, env);
  const launchEnv = buildRemoteProviderHostEnv(options, env);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bunCommand = env.BUN ?? "bun";
  const bunArgs =
    options.mode === "start"
      ? ["run", "--cwd", "apps/server", "start"]
      : ["run", "--cwd", "apps/server", "dev"];

  console.log(formatRemoteProviderHostSummary(options));
  console.log("");

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(bunCommand, bunArgs, {
      cwd: repoRoot,
      env: launchEnv,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runRemoteProviderHost(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`remote-provider-host failed: ${message}`);
      process.exit(1);
    },
  );
}
