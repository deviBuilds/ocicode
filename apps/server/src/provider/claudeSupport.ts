import type {
  ClaudeModelOptions,
  ClaudeReasoningEffort,
  ModelCapabilities,
} from "@ocicode/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelCapabilities,
  normalizeClaudeModelOptionsWithCapabilities,
} from "@ocicode/shared/model";

export type ClaudeModelCapabilities = ModelCapabilities;

export const CLAUDE_CONTEXT_1M_BETA = "context-1m-2025-08-07" as const;

export const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function getClaudeModelCapabilities(
  model: string | null | undefined,
): ClaudeModelCapabilities {
  return getModelCapabilities("claudeAgent", model);
}

export function normalizeClaudeModelOptions(
  model: string | null | undefined,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  return normalizeClaudeModelOptionsWithCapabilities(
    getClaudeModelCapabilities(model),
    modelOptions,
  );
}

export { applyClaudePromptEffortPrefix };

export function buildClaudePromptText(input: {
  readonly text: string;
  readonly model: string | null | undefined;
  readonly modelOptions: ClaudeModelOptions | null | undefined;
}): string {
  const caps = getClaudeModelCapabilities(input.model);
  const rawEffort =
    typeof input.modelOptions?.effort === "string" ? input.modelOptions.effort.trim() : null;
  const normalizedOptions = normalizeClaudeModelOptions(input.model, input.modelOptions);
  const effort =
    rawEffort && caps.promptInjectedEffortLevels.includes(rawEffort)
      ? rawEffort
      : normalizedOptions?.effort;
  const promptInjectedEffort =
    effort && caps.promptInjectedEffortLevels.includes(effort) ? effort : null;

  return applyClaudePromptEffortPrefix(
    input.text,
    promptInjectedEffort as ClaudeReasoningEffort | null,
  );
}
