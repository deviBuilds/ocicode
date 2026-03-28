import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_BY_PROVIDER, MODEL_OPTIONS_BY_PROVIDER } from "@ocicode/contracts";

import {
  applyClaudePromptEffortPrefix,
  getDefaultContextWindow,
  getDefaultEffort,
  getDefaultModel,
  getDefaultReasoningEffort,
  getModelCapabilities,
  getModelOptions,
  getReasoningEffortOptions,
  resolveEffort,
  resolveSelectableModel,
  normalizeModelSlug,
  resolveModelSlug,
} from "./model";

describe("normalizeModelSlug", () => {
  it("maps known aliases to canonical slugs", () => {
    expect(normalizeModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
    expect(normalizeModelSlug("sonnet", "claudeAgent")).toBe("claude-sonnet-4-6");
  });

  it("returns null for empty or missing values", () => {
    expect(normalizeModelSlug("")).toBeNull();
    expect(normalizeModelSlug("   ")).toBeNull();
    expect(normalizeModelSlug(null)).toBeNull();
    expect(normalizeModelSlug(undefined)).toBeNull();
  });

  it("preserves non-aliased model slugs", () => {
    expect(normalizeModelSlug("gpt-5.2")).toBe("gpt-5.2");
    expect(normalizeModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  it("does not leak prototype properties as aliases", () => {
    expect(normalizeModelSlug("toString")).toBe("toString");
    expect(normalizeModelSlug("constructor")).toBe("constructor");
  });
});

describe("resolveModelSlug", () => {
  it("returns default only when the model is missing", () => {
    expect(resolveModelSlug(undefined)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug(null)).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("preserves unknown custom models", () => {
    expect(resolveModelSlug("gpt-4.1")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(resolveModelSlug("custom/internal-model")).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  it("resolves only supported model options", () => {
    for (const model of MODEL_OPTIONS_BY_PROVIDER.codex) {
      expect(resolveModelSlug(model.slug)).toBe(model.slug);
    }
  });
  it("keeps codex defaults for backward compatibility", () => {
    expect(getDefaultModel()).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
    expect(getModelOptions()).toEqual(MODEL_OPTIONS_BY_PROVIDER.codex);
  });

  it("returns claude options for claude", () => {
    expect(getDefaultModel("claudeAgent")).toBe(DEFAULT_MODEL_BY_PROVIDER.claudeAgent);
    expect(getModelOptions("claudeAgent")).toEqual(MODEL_OPTIONS_BY_PROVIDER.claudeAgent);
  });
});

describe("getReasoningEffortOptions", () => {
  it("returns codex reasoning options for codex", () => {
    expect(getReasoningEffortOptions("codex")).toEqual(["xhigh", "high", "medium", "low"]);
  });

  it("returns claude reasoning options for claude", () => {
    expect(getReasoningEffortOptions("claudeAgent")).toEqual([
      "low",
      "medium",
      "high",
      "max",
      "ultrathink",
    ]);
  });
});

describe("getDefaultReasoningEffort", () => {
  it("returns provider-scoped defaults", () => {
    expect(getDefaultReasoningEffort("codex")).toBe("high");
    expect(getDefaultReasoningEffort("claudeAgent")).toBe("high");
  });
});

describe("model capabilities", () => {
  it("returns built-in claude capabilities", () => {
    const caps = getModelCapabilities("claudeAgent", "claude-opus-4-6");
    expect(getDefaultEffort(caps)).toBe("high");
    expect(getDefaultContextWindow(caps)).toBe("1m");
    expect(caps.promptInjectedEffortLevels).toEqual(["ultrathink"]);
  });

  it("resolves supported effort values and falls back to defaults", () => {
    const caps = getModelCapabilities("claudeAgent", "claude-sonnet-4-6");
    expect(resolveEffort(caps, "medium")).toBe("medium");
    expect(resolveEffort(caps, "ultrathink")).toBe("high");
    expect(resolveEffort(caps, "unknown")).toBe("high");
  });

  it("resolves selectable models from aliases and labels", () => {
    expect(
      resolveSelectableModel("claudeAgent", "sonnet", [
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ]),
    ).toBe("claude-sonnet-4-6");
    expect(
      resolveSelectableModel("claudeAgent", "Claude Sonnet 4.6", [
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ]),
    ).toBe("claude-sonnet-4-6");
  });

  it("injects the upstream ultrathink prompt prefix only once", () => {
    expect(applyClaudePromptEffortPrefix("Review the diff", "ultrathink")).toBe(
      "Ultrathink:\nReview the diff",
    );
    expect(applyClaudePromptEffortPrefix("Ultrathink:\nReview the diff", "ultrathink")).toBe(
      "Ultrathink:\nReview the diff",
    );
  });
});
