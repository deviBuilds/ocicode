import { describe, expect, it, vi } from "vitest";

import { syncShellEnvironment } from "./syncShellEnvironment";

describe("syncShellEnvironment", () => {
  it("does nothing on non-darwin platforms", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/existing.sock",
      SHELL: "/bin/zsh",
    };
    const readEnvironment = vi.fn(() => ({
      PATH: "/opt/homebrew/bin:/usr/bin",
      SSH_AUTH_SOCK: "/tmp/login.sock",
    }));

    syncShellEnvironment(env, { platform: "linux", readEnvironment });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/existing.sock");
  });

  it("refreshes PATH and backfills SSH_AUTH_SOCK from the login shell on macOS", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SHELL: "/bin/zsh",
    };

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment: () => ({
        PATH: "/opt/homebrew/bin:/usr/bin",
        SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.sock",
      }),
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/private/tmp/com.apple.launchd.sock");
  });

  it("preserves an inherited SSH_AUTH_SOCK value", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
      SHELL: "/bin/zsh",
    };

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment: () => ({
        PATH: "/opt/homebrew/bin:/usr/bin",
        SSH_AUTH_SOCK: "/tmp/login.sock",
      }),
    });

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });

  it("keeps the inherited environment when the login shell lookup fails", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/inherited.sock",
      SHELL: "/bin/zsh",
    };

    syncShellEnvironment(env, {
      platform: "darwin",
      readEnvironment: () => {
        throw new Error("shell lookup failed");
      },
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/inherited.sock");
  });
});
