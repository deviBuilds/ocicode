import { describe, expect, it } from "vitest";

import { getComposerProviderState } from "./composerProviderRegistry";

describe("getComposerProviderState", () => {
  it("normalizes codex options for dispatch", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      prompt: "Fix the bug",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    });

    expect(state.promptEffort).toBe("xhigh");
    expect(state.modelOptionsForDispatch).toEqual({
      reasoningEffort: "xhigh",
      fastMode: true,
    });
  });

  it("preserves claude thinking toggle models", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-haiku-4-5",
      prompt: "Summarize this",
      modelOptions: {
        claudeAgent: {
          thinking: false,
        },
      },
    });

    expect(state.promptEffort).toBeNull();
    expect(state.modelOptionsForDispatch).toEqual({
      thinking: false,
    });
  });

  it("keeps prompt-injected ultrathink out of API options", () => {
    const state = getComposerProviderState({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      prompt: "Ultrathink:\nReview this plan",
      modelOptions: {
        claudeAgent: {
          effort: "ultrathink",
          contextWindow: "1m",
        },
      },
    });

    expect(state.promptEffort).toBe("high");
    expect(state.modelOptionsForDispatch).toEqual({
      contextWindow: "1m",
      effort: "high",
    });
  });
});
