#!/usr/bin/env node
import {
  ProviderToolHostRequest,
  ProviderToolHostResponse,
  type ProviderToolHostToolName,
  ProviderToolReadFileResult,
  ProviderToolListDirectoryResult,
  ProviderToolGlobSearchResult,
  ProviderToolGrepSearchResult,
  ProviderToolWriteFileResult,
  ProviderToolApplyPatchResult,
  ProviderToolExecCommandResult,
  ProviderToolReadImageResult,
  ProviderToolWorkspaceInfoResult,
} from "@ocicode/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Schema } from "effect";
import WebSocket from "ws";
import { z } from "zod/v4";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function parseCliArgs(argv: string[]): { url: string } {
  const urlIndex = argv.findIndex((entry) => entry === "--url");
  const url = urlIndex >= 0 ? argv[urlIndex + 1] : undefined;
  if (!url) {
    throw new Error("workspaceProxyCli requires --url <ws-url>.");
  }
  return { url };
}

function websocketRawToString(raw: WebSocket.RawData): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  return null;
}

function formatStructuredResult(result: unknown): string {
  if (!result || typeof result !== "object") {
    return JSON.stringify(result, null, 2);
  }

  const record = result as Record<string, unknown>;
  if (typeof record.content === "string") {
    return record.content;
  }
  if (typeof record.stdout === "string" || typeof record.stderr === "string") {
    const sections = [];
    if (typeof record.stdout === "string" && record.stdout.length > 0) {
      sections.push(`stdout:\n${record.stdout}`);
    }
    if (typeof record.stderr === "string" && record.stderr.length > 0) {
      sections.push(`stderr:\n${record.stderr}`);
    }
    return sections.join("\n\n") || JSON.stringify(result, null, 2);
  }
  return JSON.stringify(result, null, 2);
}

class WorkspaceProxyClient {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<WebSocket> | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly url: string) {}

  private async ensureConnected(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.socket;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.url);

      const onOpen = () => {
        cleanup();
        this.socket = socket;
        socket.on("message", (raw) => this.handleMessage(raw));
        socket.on("close", () => {
          this.socket = null;
          this.rejectAllPending(new Error("Local workspace proxy connection closed."));
        });
        socket.on("error", (error) => {
          this.socket = null;
          this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
        });
        resolve(socket);
      };

      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
      };

      socket.once("open", onOpen);
      socket.once("error", onError);
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleMessage(raw: WebSocket.RawData): void {
    const text = websocketRawToString(raw);
    if (!text) {
      return;
    }

    let response: typeof ProviderToolHostResponse.Type;
    try {
      response = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderToolHostResponse))(text);
    } catch (error) {
      console.error(
        "workspace proxy dropped invalid response:",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (response.error?.message) {
      pending.reject(new Error(response.error.message));
      return;
    }
    pending.resolve(response.result);
  }

  async request(toolName: ProviderToolHostToolName, args: unknown): Promise<unknown> {
    const socket = await this.ensureConnected();
    const id = crypto.randomUUID();
    const request = {
      id,
      toolName,
      ...(args !== undefined ? { arguments: args } : {}),
    };
    const encoded = JSON.stringify(
      Schema.encodeSync(ProviderToolHostRequest)(request as typeof ProviderToolHostRequest.Type),
    );

    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(encoded, (error) => {
        if (!error) {
          return;
        }
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.rejectAllPending(new Error("Local workspace proxy connection closed."));
  }
}

const { url } = parseCliArgs(process.argv.slice(2));
const proxyClient = new WorkspaceProxyClient(url);

const server = new McpServer({
  name: "ocicode-local-workspace",
  version: "0.1.0",
});

server.registerTool(
  "local_workspace_info",
  {
    description: "Return the root directory of the local workspace that owns this remote session.",
    inputSchema: {},
  },
  async () => {
    const result = Schema.decodeUnknownSync(ProviderToolWorkspaceInfoResult)(
      await proxyClient.request("local_workspace_info", {}),
    );
    return {
      content: [{ type: "text", text: `Workspace root: ${result.cwd}` }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "local_read_file",
  {
    description:
      "Read a UTF-8 text file from the local workspace. Use startLine/endLine for targeted reads.",
    inputSchema: {
      path: z.string().min(1),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
      maxBytes: z.number().int().positive().optional(),
    },
  },
  async (args) => {
    const result = Schema.decodeUnknownSync(ProviderToolReadFileResult)(
      await proxyClient.request("local_read_file", args),
    );
    const header = `${result.path} (${result.startLine}-${result.endLine}${result.truncated ? ", truncated" : ""})`;
    return {
      content: [{ type: "text", text: `${header}\n\n${result.content}` }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "local_list_directory",
  {
    description:
      "List files and directories inside the local workspace. Use recursive=true for a deep listing.",
    inputSchema: {
      path: z.string().min(1).optional(),
      recursive: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async (args) => {
    const result = Schema.decodeUnknownSync(ProviderToolListDirectoryResult)(
      await proxyClient.request("local_list_directory", args),
    );
    return {
      content: [{ type: "text", text: formatStructuredResult(result) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "local_glob_search",
  {
    description: "Match local workspace paths with a glob pattern using ripgrep.",
    inputSchema: {
      pattern: z.string().min(1),
      limit: z.number().int().positive().optional(),
    },
  },
  async (args) => {
    const result = Schema.decodeUnknownSync(ProviderToolGlobSearchResult)(
      await proxyClient.request("local_glob_search", args),
    );
    return {
      content: [{ type: "text", text: formatStructuredResult(result) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "local_grep_search",
  {
    description: "Search local workspace file contents with ripgrep.",
    inputSchema: {
      pattern: z.string().min(1),
      glob: z.string().min(1).optional(),
      limit: z.number().int().positive().optional(),
      caseSensitive: z.boolean().optional(),
    },
  },
  async (args) => {
    const result = Schema.decodeUnknownSync(ProviderToolGrepSearchResult)(
      await proxyClient.request("local_grep_search", args),
    );
    return {
      content: [{ type: "text", text: formatStructuredResult(result) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "local_write_file",
  {
    description:
      "Write a UTF-8 text file into the local workspace, creating parent directories as needed.",
    inputSchema: {
      path: z.string().min(1),
      content: z.string(),
    },
  },
  async (args) => {
    const result = Schema.decodeUnknownSync(ProviderToolWriteFileResult)(
      await proxyClient.request("local_write_file", args),
    );
    return {
      content: [{ type: "text", text: formatStructuredResult(result) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "local_apply_patch",
  {
    description:
      "Apply a unified diff patch to the local workspace using git apply. Prefer this for surgical edits.",
    inputSchema: {
      patch: z.string().min(1),
    },
  },
  async (args) => {
    const result = Schema.decodeUnknownSync(ProviderToolApplyPatchResult)(
      await proxyClient.request("local_apply_patch", args),
    );
    return {
      content: [{ type: "text", text: formatStructuredResult(result) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "local_exec_command",
  {
    description:
      "Run a shell command against the local workspace. Use this for builds, tests, linters, and repo inspection.",
    inputSchema: {
      command: z.string().min(1),
      cwd: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
    },
  },
  async (args) => {
    const result = Schema.decodeUnknownSync(ProviderToolExecCommandResult)(
      await proxyClient.request("local_exec_command", args),
    );
    return {
      content: [{ type: "text", text: formatStructuredResult(result) }],
      structuredContent: result,
    };
  },
);

server.registerTool(
  "local_read_image",
  {
    description: "Read an image from the local workspace and return it as base64 metadata.",
    inputSchema: {
      path: z.string().min(1),
    },
  },
  async (args) => {
    const result = Schema.decodeUnknownSync(ProviderToolReadImageResult)(
      await proxyClient.request("local_read_image", args),
    );
    return {
      content: [{ type: "text", text: formatStructuredResult(result) }],
      structuredContent: result,
    };
  },
);

const transport = new StdioServerTransport();
void server.connect(transport).catch((error) => {
  console.error("workspace proxy server failed:", error instanceof Error ? error.message : error);
  proxyClient.close();
  process.exitCode = 1;
});

process.on("SIGINT", async () => {
  proxyClient.close();
  await server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  proxyClient.close();
  await server.close();
  process.exit(0);
});
