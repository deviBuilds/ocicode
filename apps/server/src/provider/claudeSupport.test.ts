import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { getDefaultContextWindow } from "@ocicode/shared/model";

import {
  CLAUDE_CONTEXT_1M_BETA,
  applyClaudePromptEffortPrefix,
  buildClaudePromptText,
  getClaudeModelCapabilities,
  normalizeClaudeModelOptions,
} from "./claudeSupport";

describe("claudeSupport", () => {
  it("returns built-in capabilities for Claude Sonnet 4.6", () => {
    const caps = getClaudeModelCapabilities("sonnet");
    assert.deepStrictEqual(
      caps.reasoningEffortLevels.map((level) => level.value),
      ["low", "medium", "high", "ultrathink"],
    );
    assert.deepStrictEqual(
      caps.contextWindowOptions.map((option) => option.value),
      ["200k", "1m"],
    );
    assert.strictEqual(getDefaultContextWindow(caps), "1m");
  });

  it("normalizes Claude model options against model capabilities", () => {
    const normalized = normalizeClaudeModelOptions("claude-opus-4-6", {
      effort: "max",
      fastMode: true,
      contextWindow: "1m",
      thinking: false,
    });

    assert.deepStrictEqual(normalized, {
      effort: "max",
      fastMode: true,
      contextWindow: "1m",
    });
  });

  it("drops unsupported options and falls back to Claude defaults", () => {
    const normalized = normalizeClaudeModelOptions("claude-sonnet-4-6", {
      effort: "max",
      fastMode: true,
      contextWindow: "unknown",
      thinking: false,
    });

    assert.deepStrictEqual(normalized, {
      effort: "high",
      contextWindow: "1m",
    });
  });

  it("injects ultrathink into the prompt for prompt-only effort levels", () => {
    const prompt = buildClaudePromptText({
      text: "Review this diff",
      model: "claude-sonnet-4-6",
      modelOptions: {
        effort: "ultrathink",
      },
    });

    assert.strictEqual(prompt, "Ultrathink:\nReview this diff");
  });

  it("leaves non-prompt-injected efforts in the API layer", () => {
    assert.strictEqual(
      applyClaudePromptEffortPrefix("Review this diff", "high"),
      "Review this diff",
    );
  });

  it("exports the expected 1M context beta identifier", () => {
    assert.strictEqual(CLAUDE_CONTEXT_1M_BETA, "context-1m-2025-08-07");
  });
});
