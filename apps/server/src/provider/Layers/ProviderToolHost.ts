import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import Mime from "@effect/platform-node/Mime";
import {
  ProviderToolApplyPatchArgs,
  ProviderToolExecCommandArgs,
  ProviderToolGlobSearchArgs,
  ProviderToolGrepSearchArgs,
  ProviderToolListDirectoryArgs,
  ProviderToolReadFileArgs,
  ProviderToolReadImageArgs,
  ProviderToolWorkspaceInfoArgs,
  ProviderToolWriteFileArgs,
  type ThreadId,
} from "@ocicode/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "../../imageMime.ts";
import { runProcess } from "../../processRunner.ts";
import { ProviderToolHostError } from "../Errors.ts";
import {
  ProviderToolHost,
  type ProviderToolHostOpenSessionResult,
  type ProviderToolHostShape,
} from "../Services/ProviderToolHost.ts";

type DirectoryEntry = {
  readonly path: string;
  readonly type: "file" | "directory";
};

const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 200;
const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const MAX_APPLY_PATCH_BYTES = 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;

function toToolHostError(
  operation: string,
  detail: string,
  cause?: unknown,
): ProviderToolHostError {
  return new ProviderToolHostError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function ensureWithinWorkspace(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw toToolHostError(
      "ProviderToolHost.resolvePath",
      `Path '${candidate}' is outside the workspace root.`,
    );
  }
  return candidate;
}

function resolveWorkspacePath(root: string, inputPath: string): string {
  const resolved = path.resolve(root, inputPath);
  return ensureWithinWorkspace(root, resolved);
}

function toWorkspaceRelativePath(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative.length > 0 ? relative.split(path.sep).join("/") : ".";
}

async function collectDirectoryEntries(input: {
  root: string;
  currentPath: string;
  recursive: boolean;
  limit: number;
}): Promise<{ readonly entries: ReadonlyArray<DirectoryEntry>; readonly truncated: boolean }> {
  const entries: DirectoryEntry[] = [];
  let truncated = false;

  const visit = async (absoluteDir: string) => {
    if (entries.length >= input.limit) {
      truncated = true;
      return;
    }

    const dirEntries = await fs.readdir(absoluteDir, { withFileTypes: true });
    dirEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const dirEntry of dirEntries) {
      if (entries.length >= input.limit) {
        truncated = true;
        return;
      }

      const absoluteEntryPath = path.join(absoluteDir, dirEntry.name);
      const relativePath = toWorkspaceRelativePath(input.root, absoluteEntryPath);
      const type = dirEntry.isDirectory() ? "directory" : "file";
      entries.push({ path: relativePath, type });

      if (input.recursive && dirEntry.isDirectory()) {
        await visit(absoluteEntryPath);
      }
    }
  };

  await visit(input.currentPath);
  return { entries, truncated };
}

function normalizeReadWindow(input: {
  readonly totalLines: number;
  readonly startLine?: number;
  readonly endLine?: number;
}) {
  const requestedStart = Math.max(1, input.startLine ?? 1);
  const requestedEnd = Math.max(requestedStart, input.endLine ?? input.totalLines);
  return {
    startLine: requestedStart,
    endLine: Math.min(requestedEnd, Math.max(input.totalLines, 1)),
  };
}

function shellCommandForPlatform(command: string): {
  readonly file: string;
  readonly args: string[];
} {
  if (process.platform === "win32") {
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  return {
    file: process.env.SHELL ?? "/bin/sh",
    args: ["-lc", command],
  };
}

const makeProviderToolHost = Effect.sync(() => {
  const sessionTokenByThreadId = new Map<ThreadId, string>();
  const threadIdBySessionToken = new Map<string, ThreadId>();

  const openSession: ProviderToolHostShape["openSession"] = (threadId) =>
    Effect.sync(() => {
      const existingToken = sessionTokenByThreadId.get(threadId);
      if (existingToken) {
        return { token: existingToken } satisfies ProviderToolHostOpenSessionResult;
      }
      const token = randomUUID();
      sessionTokenByThreadId.set(threadId, token);
      threadIdBySessionToken.set(token, threadId);
      return { token } satisfies ProviderToolHostOpenSessionResult;
    });

  const closeSession: ProviderToolHostShape["closeSession"] = (threadId) =>
    Effect.sync(() => {
      const token = sessionTokenByThreadId.get(threadId);
      if (!token) {
        return;
      }
      sessionTokenByThreadId.delete(threadId);
      threadIdBySessionToken.delete(token);
    });

  const resolveThreadId: ProviderToolHostShape["resolveThreadId"] = (token) =>
    Effect.sync(() => {
      const threadId = threadIdBySessionToken.get(token);
      return threadId === undefined ? Option.none<ThreadId>() : Option.some(threadId);
    });

  const callTool: ProviderToolHostShape["callTool"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        const workspaceRoot = path.resolve(input.cwd ?? process.cwd());

        switch (input.toolName) {
          case "local_workspace_info": {
            Schema.decodeUnknownSync(ProviderToolWorkspaceInfoArgs)(input.args ?? {});
            return {
              cwd: workspaceRoot,
            };
          }

          case "local_read_file": {
            const args = Schema.decodeUnknownSync(ProviderToolReadFileArgs)(input.args ?? {});
            const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);
            const content = await fs.readFile(absolutePath, "utf8");
            const totalLines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
            const { startLine, endLine } = normalizeReadWindow({
              totalLines,
              ...(args.startLine !== undefined ? { startLine: args.startLine } : {}),
              ...(args.endLine !== undefined ? { endLine: args.endLine } : {}),
            });
            const lines = totalLines === 0 ? [] : content.split(/\r?\n/);
            const sliced = lines.slice(Math.max(startLine - 1, 0), endLine);
            const joined = sliced.join("\n");
            const maxBytes = args.maxBytes ?? DEFAULT_READ_MAX_BYTES;
            const buffer = Buffer.from(joined, "utf8");
            const truncated = buffer.length > maxBytes;
            return {
              path: toWorkspaceRelativePath(workspaceRoot, absolutePath),
              content: truncated ? buffer.subarray(0, maxBytes).toString("utf8") : joined,
              startLine,
              endLine,
              totalLines,
              truncated,
            };
          }

          case "local_list_directory": {
            const args = Schema.decodeUnknownSync(ProviderToolListDirectoryArgs)(input.args ?? {});
            const absolutePath = resolveWorkspacePath(
              workspaceRoot,
              args.path?.trim() && args.path !== "." ? args.path : ".",
            );
            const limit = Math.max(1, args.limit ?? DEFAULT_LIST_LIMIT);
            return collectDirectoryEntries({
              root: workspaceRoot,
              currentPath: absolutePath,
              recursive: args.recursive ?? false,
              limit,
            });
          }

          case "local_glob_search": {
            const args = Schema.decodeUnknownSync(ProviderToolGlobSearchArgs)(input.args ?? {});
            const limit = Math.max(1, args.limit ?? DEFAULT_SEARCH_LIMIT);
            const result = await runProcess("rg", ["--files", "-g", args.pattern], {
              cwd: workspaceRoot,
              allowNonZeroExit: true,
              outputMode: "truncate",
              maxBufferBytes: 2 * 1024 * 1024,
            });
            if (result.code !== 0 && result.code !== 1) {
              throw toToolHostError(
                "ProviderToolHost.local_glob_search",
                result.stderr.trim() || `ripgrep exited with code ${result.code ?? "null"}.`,
              );
            }
            const matches = result.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .slice(0, limit);
            return {
              matches,
              truncated: matches.length >= limit,
            };
          }

          case "local_grep_search": {
            const args = Schema.decodeUnknownSync(ProviderToolGrepSearchArgs)(input.args ?? {});
            const limit = Math.max(1, args.limit ?? DEFAULT_SEARCH_LIMIT);
            const rgArgs = [
              "--json",
              "-n",
              ...(args.caseSensitive ? ["--case-sensitive"] : ["--ignore-case"]),
              ...(args.glob ? ["--glob", args.glob] : []),
              args.pattern,
              ".",
            ];
            const result = await runProcess("rg", rgArgs, {
              cwd: workspaceRoot,
              allowNonZeroExit: true,
              outputMode: "truncate",
              maxBufferBytes: 2 * 1024 * 1024,
            });
            if (result.code !== 0 && result.code !== 1) {
              throw toToolHostError(
                "ProviderToolHost.local_grep_search",
                result.stderr.trim() || `ripgrep exited with code ${result.code ?? "null"}.`,
              );
            }
            const matches: Array<{ path: string; lineNumber: number; line: string }> = [];
            for (const line of result.stdout.split(/\r?\n/)) {
              if (matches.length >= limit || line.trim().length === 0) {
                break;
              }
              const record = JSON.parse(line) as Record<string, unknown>;
              if (record.type !== "match") {
                continue;
              }
              const data = (record.data ?? {}) as Record<string, unknown>;
              const pathText =
                ((data.path ?? {}) as Record<string, unknown>).text ??
                ((data.path ?? {}) as Record<string, unknown>).path;
              const linesText = ((data.lines ?? {}) as Record<string, unknown>).text;
              const lineNumber = data.line_number;
              if (
                typeof pathText !== "string" ||
                typeof linesText !== "string" ||
                typeof lineNumber !== "number"
              ) {
                continue;
              }
              const absoluteMatchPath = resolveWorkspacePath(workspaceRoot, pathText);
              matches.push({
                path: toWorkspaceRelativePath(workspaceRoot, absoluteMatchPath),
                lineNumber,
                line: linesText.replace(/\r?\n$/, ""),
              });
            }
            return {
              matches,
              truncated: matches.length >= limit,
            };
          }

          case "local_write_file": {
            const args = Schema.decodeUnknownSync(ProviderToolWriteFileArgs)(input.args ?? {});
            const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);
            await fs.mkdir(path.dirname(absolutePath), { recursive: true });
            await fs.writeFile(absolutePath, args.content, "utf8");
            return {
              path: toWorkspaceRelativePath(workspaceRoot, absolutePath),
              bytesWritten: Buffer.byteLength(args.content, "utf8"),
            };
          }

          case "local_apply_patch": {
            const args = Schema.decodeUnknownSync(ProviderToolApplyPatchArgs)(input.args ?? {});
            if (Buffer.byteLength(args.patch, "utf8") > MAX_APPLY_PATCH_BYTES) {
              throw toToolHostError(
                "ProviderToolHost.local_apply_patch",
                "Patch exceeds the maximum allowed size.",
              );
            }
            const result = await runProcess(
              "git",
              ["apply", "--whitespace=nowarn", "--recount", "--unsafe-paths", "-"],
              {
                cwd: workspaceRoot,
                allowNonZeroExit: true,
                stdin: args.patch,
                outputMode: "truncate",
                maxBufferBytes: 2 * 1024 * 1024,
              },
            );
            if (result.code !== 0) {
              throw toToolHostError(
                "ProviderToolHost.local_apply_patch",
                result.stderr.trim() || "git apply failed.",
              );
            }
            return {
              applied: true,
              stdout: result.stdout,
              stderr: result.stderr,
            };
          }

          case "local_exec_command": {
            const args = Schema.decodeUnknownSync(ProviderToolExecCommandArgs)(input.args ?? {});
            const resolvedCwd = args.cwd
              ? resolveWorkspacePath(workspaceRoot, args.cwd)
              : workspaceRoot;
            const shellCommand = shellCommandForPlatform(args.command);
            const result = await runProcess(shellCommand.file, shellCommand.args, {
              cwd: resolvedCwd,
              allowNonZeroExit: true,
              timeoutMs: args.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
              outputMode: "truncate",
              maxBufferBytes: 4 * 1024 * 1024,
            });
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              code: result.code,
              signal: result.signal,
              timedOut: result.timedOut,
            };
          }

          case "local_read_image": {
            const args = Schema.decodeUnknownSync(ProviderToolReadImageArgs)(input.args ?? {});
            const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);
            const bytes = await fs.readFile(absolutePath);
            const extension = inferImageExtension({
              mimeType: Mime.getType(path.basename(absolutePath)) ?? "application/octet-stream",
              fileName: absolutePath,
            });
            if (!SAFE_IMAGE_FILE_EXTENSIONS.has(extension)) {
              throw toToolHostError(
                "ProviderToolHost.local_read_image",
                `File '${args.path}' is not a supported image.`,
              );
            }
            const mimeType = Mime.getType(absolutePath) ?? "application/octet-stream";
            return {
              path: toWorkspaceRelativePath(workspaceRoot, absolutePath),
              mimeType,
              base64: Buffer.from(bytes).toString("base64"),
              sizeBytes: bytes.length,
            };
          }

          default:
            throw toToolHostError(
              "ProviderToolHost.callTool",
              `Unsupported local workspace proxy tool '${input.toolName}'.`,
            );
        }
      },
      catch: (cause) => {
        if (Schema.is(ProviderToolHostError)(cause)) {
          return cause;
        }
        if (cause instanceof Error) {
          return toToolHostError("ProviderToolHost.callTool", cause.message, cause);
        }
        return toToolHostError("ProviderToolHost.callTool", String(cause), cause);
      },
    });

  return {
    openSession,
    closeSession,
    resolveThreadId,
    callTool,
  } satisfies ProviderToolHostShape;
});

export const ProviderToolHostLive = Layer.effect(ProviderToolHost, makeProviderToolHost);
