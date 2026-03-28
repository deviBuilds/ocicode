import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ProviderToolApplyPatchResult,
  ProviderToolExecCommandResult,
  ProviderToolGrepSearchResult,
  ProviderToolReadFileResult,
  ProviderToolWorkspaceInfoResult,
  ProviderToolWriteFileResult,
  ThreadId,
} from "@ocicode/contracts";
import { Effect, Option, Schema } from "effect";
import { afterEach, describe, it } from "vitest";

import { ProviderToolHostError } from "../Errors.ts";
import { ProviderToolHost } from "../Services/ProviderToolHost.ts";
import { ProviderToolHostLive } from "./ProviderToolHost.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

const tempDirs: string[] = [];

function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix)).then((dir) => {
    tempDirs.push(dir);
    return dir;
  });
}

function runToolHost<A>(
  effect: Effect.Effect<A, ProviderToolHostError, ProviderToolHost>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(ProviderToolHostLive)));
}

describe("ProviderToolHost", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("opens and closes session-scoped tokens", async () => {
    await runToolHost(
      Effect.gen(function* () {
        const host = yield* ProviderToolHost;
        const threadId = asThreadId("thread-provider-tool-host");

        const first = yield* host.openSession(threadId);
        const second = yield* host.openSession(threadId);
        assert.equal(first.token, second.token);

        const resolved = yield* host.resolveThreadId(first.token);
        assert.equal(Option.isSome(resolved), true);
        if (Option.isSome(resolved)) {
          assert.equal(resolved.value, threadId);
        }

        yield* host.closeSession(threadId);
        const afterClose = yield* host.resolveThreadId(first.token);
        assert.equal(Option.isNone(afterClose), true);
      }),
    );
  });

  it("reads and writes files inside the local workspace root", async () => {
    const cwd = await createTempDir("ocicode-provider-tool-host-");

    await runToolHost(
      Effect.gen(function* () {
        const host = yield* ProviderToolHost;
        const threadId = asThreadId("thread-read-write");

        const workspaceInfo = Schema.decodeUnknownSync(ProviderToolWorkspaceInfoResult)(
          yield* host.callTool({
            threadId,
            cwd,
            toolName: "local_workspace_info",
            args: {},
          }),
        );
        assert.equal(workspaceInfo.cwd, cwd);

        const writeResult = Schema.decodeUnknownSync(ProviderToolWriteFileResult)(
          yield* host.callTool({
            threadId,
            cwd,
            toolName: "local_write_file",
            args: {
              path: "notes/todo.txt",
              content: "first line\nsecond line\nthird line\n",
            },
          }),
        );
        assert.equal(writeResult.path, "notes/todo.txt");
        assert.equal(writeResult.bytesWritten > 0, true);

        const readResult = Schema.decodeUnknownSync(ProviderToolReadFileResult)(
          yield* host.callTool({
            threadId,
            cwd,
            toolName: "local_read_file",
            args: {
              path: "notes/todo.txt",
              startLine: 2,
              endLine: 3,
            },
          }),
        );
        assert.equal(readResult.path, "notes/todo.txt");
        assert.equal(readResult.content, "second line\nthird line");
        assert.equal(readResult.startLine, 2);
        assert.equal(readResult.endLine, 3);
        assert.equal(readResult.totalLines, 4);
        assert.equal(readResult.truncated, false);
      }),
    );
  });

  it("rejects paths outside the local workspace root", async () => {
    const cwd = await createTempDir("ocicode-provider-tool-host-");

    await assert.rejects(
      () =>
        runToolHost(
          Effect.gen(function* () {
            const host = yield* ProviderToolHost;
            return yield* host.callTool({
              threadId: asThreadId("thread-path-guard"),
              cwd,
              toolName: "local_write_file",
              args: {
                path: "../escape.txt",
                content: "should fail",
              },
            });
          }),
        ),
      (error) =>
        Schema.is(ProviderToolHostError)(error) &&
        error.operation === "ProviderToolHost.resolvePath" &&
        error.detail.includes("outside the workspace root"),
    );
  });

  it("applies patches, searches files, and executes commands locally", async () => {
    const cwd = await createTempDir("ocicode-provider-tool-host-");
    await fs.writeFile(path.join(cwd, "note.txt"), "before\n", "utf8");
    await fs.mkdir(path.join(cwd, "nested"), { recursive: true });

    await runToolHost(
      Effect.gen(function* () {
        const host = yield* ProviderToolHost;
        const threadId = asThreadId("thread-patch-exec");

        const applyPatchResult = Schema.decodeUnknownSync(ProviderToolApplyPatchResult)(
          yield* host.callTool({
            threadId,
            cwd,
            toolName: "local_apply_patch",
            args: {
              patch: [
                "diff --git a/note.txt b/note.txt",
                "--- a/note.txt",
                "+++ b/note.txt",
                "@@ -1 +1 @@",
                "-before",
                "+after",
                "",
              ].join("\n"),
            },
          }),
        );
        assert.equal(applyPatchResult.applied, true);

        const grepResult = Schema.decodeUnknownSync(ProviderToolGrepSearchResult)(
          yield* host.callTool({
            threadId,
            cwd,
            toolName: "local_grep_search",
            args: {
              pattern: "after",
              glob: "*.txt",
            },
          }),
        );
        assert.deepEqual(grepResult.matches, [
          {
            path: "note.txt",
            lineNumber: 1,
            line: "after",
          },
        ]);

        const execResult = Schema.decodeUnknownSync(ProviderToolExecCommandResult)(
          yield* host.callTool({
            threadId,
            cwd,
            toolName: "local_exec_command",
            args: {
              cwd: "nested",
              command: process.platform === "win32" ? "cd" : "pwd",
            },
          }),
        );
        assert.equal(execResult.code, 0);
        assert.equal(execResult.stderr, "");
        assert.equal(execResult.timedOut, false);
        const expectedCwd = yield* Effect.promise(() => fs.realpath(path.join(cwd, "nested")));
        const actualCwd = yield* Effect.promise(() => fs.realpath(execResult.stdout.trim()));
        assert.equal(actualCwd, expectedCwd);
      }),
    );
  });
});
