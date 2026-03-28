import * as FS from "node:fs";
import * as Net from "node:net";
import * as Readline from "node:readline";
import type { Readable } from "node:stream";

import { Data, Effect, Option, Schema } from "effect";

class BootstrapError extends Data.TaggedError("BootstrapError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function readBootstrapEnvelope<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  fd: number,
  options?: {
    timeoutMs?: number;
  },
): Effect.Effect<Option.Option<S["Type"]>, BootstrapError> {
  return Effect.gen(function* () {
    const fdReady = yield* isFdReady(fd);
    if (!fdReady) {
      return Option.none();
    }

    const stream = yield* makeBootstrapInputStream(fd);
    const decodeEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(schema));

    return yield* Effect.tryPromise({
      try: () =>
        new Promise<Option.Option<S["Type"]>>((resolve, reject) => {
          const input = Readline.createInterface({
            input: stream,
            crlfDelay: Infinity,
          });
          const timeoutMs = options?.timeoutMs ?? 1_000;
          let settled = false;

          const cleanup = () => {
            input.removeAllListeners();
            stream.removeAllListeners();
            input.close();
            stream.destroy();
          };

          const finish = (result: Option.Option<S["Type"]>) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            cleanup();
            resolve(result);
          };

          const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            cleanup();
            reject(error);
          };

          const timeoutId = setTimeout(() => {
            finish(Option.none());
          }, timeoutMs);

          stream.once("error", (error) => {
            if (isUnavailableBootstrapFdError(error)) {
              finish(Option.none());
              return;
            }
            fail(error);
          });
          input.once("line", (line) => {
            try {
              finish(Option.some(decodeEnvelope(line)));
            } catch (error) {
              fail(error);
            }
          });
          input.once("close", () => {
            finish(Option.none());
          });
        }),
      catch: (cause) =>
        new BootstrapError({
          message: "Failed to read bootstrap envelope.",
          cause,
        }),
    });
  });
}

function isUnavailableBootstrapFdError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  return error.code === "EBADF" || error.code === "ENOENT";
}

const isFdReady = (fd: number) =>
  Effect.try({
    try: () => FS.fstatSync(fd),
    catch: (error) =>
      new BootstrapError({
        message: "Failed to stat bootstrap fd.",
        cause: error,
      }),
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => isUnavailableBootstrapFdError(error.cause),
      () => Effect.succeed(false),
    ),
  );

const makeBootstrapInputStream = (fd: number) =>
  Effect.try<Readable, BootstrapError>({
    try: () => {
      const fdPath = resolveFdPath(fd);
      if (fdPath === undefined) {
        const stream = new Net.Socket({
          fd,
          readable: true,
          writable: false,
        });
        stream.setEncoding("utf8");
        return stream;
      }

      const streamFd = FS.openSync(fdPath, "r");
      return FS.createReadStream("", {
        fd: streamFd,
        encoding: "utf8",
        autoClose: true,
      });
    },
    catch: (error) =>
      new BootstrapError({
        message: "Failed to duplicate bootstrap fd.",
        cause: error,
      }),
  });

export function resolveFdPath(
  fd: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "linux") {
    return `/proc/self/fd/${fd}`;
  }
  if (platform === "win32") {
    return undefined;
  }
  return `/dev/fd/${fd}`;
}
