import { existsSync } from "node:fs";
import path from "node:path";

export interface WorkspaceProxyProcessConfig {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export function resolveWorkspaceProxyCliPath(): string {
  const candidates = [
    path.resolve(import.meta.dirname, "workspaceProxyCli.ts"),
    path.resolve(import.meta.dirname, "workspaceProxyCli.js"),
    path.resolve(import.meta.dirname, "workspaceProxyCli.mjs"),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error("Unable to locate the local workspace MCP proxy executable.");
  }
  return resolved;
}

export function buildWorkspaceProxyProcessConfig(url: string): WorkspaceProxyProcessConfig {
  return {
    command: process.execPath,
    args: [resolveWorkspaceProxyCliPath(), "--url", url],
  };
}

export function buildWorkspaceProxyUrl(port: number, token: string): string {
  return `ws://127.0.0.1:${port}/provider-tool-host?token=${encodeURIComponent(token)}`;
}
