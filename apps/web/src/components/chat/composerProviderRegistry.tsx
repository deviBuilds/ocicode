import { type ProviderKind, type ProviderModelOptions } from "@ocicode/contracts";
import {
  getModelCapabilities,
  isClaudeUltrathinkPrompt,
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  resolveEffort,
} from "@ocicode/shared/model";
import type { ReactNode } from "react";

import { TraitsMenuContent, TraitsPicker } from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderKind;
  model: string;
  prompt: string;
  modelOptions: ProviderModelOptions | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ProviderModelOptions[ProviderKind] | undefined;
  modelPickerIconClassName?: string;
};

type RenderTraitsInput = {
  provider: ProviderKind;
  model: string;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onModelOptionsChange: (nextOptions: ProviderModelOptions[ProviderKind] | undefined) => void;
};

function getProviderStateFromCapabilities(
  input: ComposerProviderStateInput,
): ComposerProviderState {
  const caps = getModelCapabilities(input.provider, input.model);
  const providerOptions = input.modelOptions?.[input.provider];
  const rawEffort = providerOptions
    ? "effort" in providerOptions
      ? providerOptions.effort
      : "reasoningEffort" in providerOptions
        ? providerOptions.reasoningEffort
        : null
    : null;
  const promptEffort = resolveEffort(caps, rawEffort) ?? null;
  const normalizedOptions =
    input.provider === "codex"
      ? normalizeCodexModelOptionsWithCapabilities(caps, providerOptions)
      : normalizeClaudeModelOptionsWithCapabilities(caps, providerOptions);
  const ultrathinkActive =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(input.prompt);

  return {
    provider: input.provider,
    promptEffort,
    modelOptionsForDispatch: normalizedOptions,
    ...(ultrathinkActive ? { modelPickerIconClassName: "text-[#d97757]" } : {}),
  };
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  return getProviderStateFromCapabilities(input);
}

export function renderProviderTraitsMenuContent(input: RenderTraitsInput): ReactNode {
  return (
    <TraitsMenuContent
      provider={input.provider}
      model={input.model}
      modelOptions={input.modelOptions}
      prompt={input.prompt}
      onPromptChange={input.onPromptChange}
      onModelOptionsChange={input.onModelOptionsChange}
    />
  );
}

export function renderProviderTraitsPicker(input: RenderTraitsInput): ReactNode {
  return (
    <TraitsPicker
      provider={input.provider}
      model={input.model}
      modelOptions={input.modelOptions}
      prompt={input.prompt}
      onPromptChange={input.onPromptChange}
      onModelOptionsChange={input.onModelOptionsChange}
    />
  );
}
