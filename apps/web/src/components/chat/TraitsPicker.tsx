import {
  type ClaudeModelOptions,
  type CodexModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
} from "@ocicode/contracts";
import {
  applyClaudePromptEffortPrefix,
  getDefaultContextWindow,
  getDefaultEffort,
  getModelCapabilities,
  hasContextWindowOption,
  isClaudeUltrathinkPrompt,
  resolveEffort,
  trimOrNull,
} from "@ocicode/shared/model";
import { memo, useCallback, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

type ProviderOptions = ProviderModelOptions[ProviderKind];

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function getRawEffort(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "codex") {
    return trimOrNull((modelOptions as CodexModelOptions | undefined)?.reasoningEffort);
  }
  return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.effort);
}

function getRawContextWindow(modelOptions: ProviderOptions | null | undefined): string | null {
  return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.contextWindow);
}

function buildNextOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  if (provider === "codex") {
    return { ...(modelOptions as CodexModelOptions | undefined), ...patch } as CodexModelOptions;
  }
  return { ...(modelOptions as ClaudeModelOptions | undefined), ...patch } as ClaudeModelOptions;
}

function getSelectedTraits(
  provider: ProviderKind,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
) {
  const caps = getModelCapabilities(provider, model);
  const effortLevels = allowPromptInjectedEffort
    ? caps.reasoningEffortLevels
    : caps.reasoningEffortLevels.filter(
        (option) => !caps.promptInjectedEffortLevels.includes(option.value),
      );
  const rawEffort = getRawEffort(provider, modelOptions);
  const effort = resolveEffort(caps, rawEffort) ?? null;
  const thinkingEnabled = caps.supportsThinkingToggle
    ? ((modelOptions as ClaudeModelOptions | undefined)?.thinking ?? true)
    : null;
  const fastModeEnabled =
    caps.supportsFastMode &&
    (modelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;
  const contextWindowOptions = caps.contextWindowOptions;
  const rawContextWindow = getRawContextWindow(modelOptions);
  const defaultContextWindow = getDefaultContextWindow(caps);
  const contextWindow =
    rawContextWindow && hasContextWindowOption(caps, rawContextWindow)
      ? rawContextWindow
      : defaultContextWindow;
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    caps.promptInjectedEffortLevels.length > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  return {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  };
}

export interface TraitsMenuContentProps {
  provider: ProviderKind;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  onModelOptionsChange: (nextOptions: ProviderOptions | undefined) => void;
  allowPromptInjectedEffort?: boolean;
}

export function hasProviderTraits(
  provider: ProviderKind,
  model: string | null | undefined,
): boolean {
  const caps = getModelCapabilities(provider, model);
  return (
    caps.reasoningEffortLevels.length > 0 ||
    caps.supportsThinkingToggle ||
    caps.supportsFastMode ||
    caps.contextWindowOptions.length > 1
  );
}

export const TraitsMenuContent = memo(function TraitsMenuContent({
  provider,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  onModelOptionsChange,
  allowPromptInjectedEffort = true,
}: TraitsMenuContentProps) {
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  } = getSelectedTraits(provider, model, prompt, modelOptions, allowPromptInjectedEffort);
  const defaultEffort = getDefaultEffort(caps);

  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      onModelOptionsChange(nextOptions);
    },
    [onModelOptionsChange],
  );

  const handleEffortChange = useCallback(
    (value: string) => {
      if (ultrathinkPromptControlled) return;
      if (!value) return;
      const nextOption = effortLevels.find((option) => option.value === value);
      if (!nextOption) return;
      if (caps.promptInjectedEffortLevels.includes(nextOption.value)) {
        const nextPrompt =
          prompt.trim().length === 0
            ? ULTRATHINK_PROMPT_PREFIX
            : applyClaudePromptEffortPrefix(prompt, "ultrathink");
        onPromptChange(nextPrompt);
        return;
      }
      const effortKey = provider === "codex" ? "reasoningEffort" : "effort";
      updateModelOptions(
        buildNextOptions(provider, modelOptions, { [effortKey]: nextOption.value }),
      );
    },
    [
      caps.promptInjectedEffortLevels,
      effortLevels,
      modelOptions,
      onPromptChange,
      prompt,
      provider,
      ultrathinkPromptControlled,
      updateModelOptions,
    ],
  );

  if (
    effort === null &&
    thinkingEnabled === null &&
    !caps.supportsFastMode &&
    contextWindowOptions.length <= 1
  ) {
    return null;
  }

  return (
    <>
      {effort ? (
        <MenuGroup>
          <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">Effort</div>
          {ultrathinkPromptControlled ? (
            <div className="px-2 pb-1.5 text-xs text-muted-foreground/80">
              Remove Ultrathink from the prompt to change effort.
            </div>
          ) : null}
          <MenuRadioGroup value={effort} onValueChange={handleEffortChange}>
            {effortLevels.map((option) => (
              <MenuRadioItem
                key={option.value}
                value={option.value}
                disabled={ultrathinkPromptControlled}
              >
                {option.label}
                {option.value === defaultEffort ? " (default)" : ""}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      ) : thinkingEnabled !== null ? (
        <MenuGroup>
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Thinking</div>
          <MenuRadioGroup
            value={thinkingEnabled ? "on" : "off"}
            onValueChange={(value) => {
              updateModelOptions(
                buildNextOptions(provider, modelOptions, {
                  thinking: value === "off" ? false : undefined,
                }),
              );
            }}
          >
            <MenuRadioItem value="on">On (default)</MenuRadioItem>
            <MenuRadioItem value="off">Off</MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      ) : null}
      {caps.supportsFastMode ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Fast Mode</div>
            <MenuRadioGroup
              value={fastModeEnabled ? "on" : "off"}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    fastMode: value === "on" ? true : undefined,
                  }),
                );
              }}
            >
              <MenuRadioItem value="off">off</MenuRadioItem>
              <MenuRadioItem value="on">on</MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
      {contextWindowOptions.length > 1 ? (
        <>
          <MenuDivider />
          <MenuGroup>
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Context Window
            </div>
            <MenuRadioGroup
              value={contextWindow ?? defaultContextWindow ?? ""}
              onValueChange={(value) => {
                updateModelOptions(
                  buildNextOptions(provider, modelOptions, {
                    contextWindow: value,
                  }),
                );
              }}
            >
              {contextWindowOptions.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                  {option.value === defaultContextWindow ? " (default)" : ""}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </>
      ) : null}
    </>
  );
});

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  onModelOptionsChange,
  allowPromptInjectedEffort = true,
  triggerVariant,
  triggerClassName,
}: TraitsMenuContentProps & {
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const {
    caps,
    effort,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
  } = getSelectedTraits(provider, model, prompt, modelOptions, allowPromptInjectedEffort);

  if (
    effort === null &&
    thinkingEnabled === null &&
    !caps.supportsFastMode &&
    contextWindowOptions.length <= 1
  ) {
    return null;
  }

  const effortLabel = effort
    ? (effortLevels.find((level) => level.value === effort)?.label ?? effort)
    : null;
  const contextWindowLabel =
    contextWindowOptions.length > 1 && contextWindow !== defaultContextWindow
      ? (contextWindowOptions.find((option) => option.value === contextWindow)?.label ?? null)
      : null;
  const triggerLabel = [
    ultrathinkPromptControlled
      ? "Ultrathink"
      : effortLabel
        ? effortLabel
        : thinkingEnabled === null
          ? null
          : `Thinking ${thinkingEnabled ? "On" : "Off"}`,
    ...(caps.supportsFastMode && fastModeEnabled ? ["Fast"] : []),
    ...(contextWindowLabel ? [contextWindowLabel] : []),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Menu open={isMenuOpen} onOpenChange={setIsMenuOpen}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={triggerVariant ?? "ghost"}
            className={cn(
              provider === "codex"
                ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:max-w-48 sm:px-3 [&_svg]:mx-0"
                : "shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3",
              triggerClassName,
            )}
          />
        }
      >
        <span
          className={cn(
            "flex items-center gap-2",
            provider === "codex" ? "min-w-0 w-full overflow-hidden" : undefined,
          )}
        >
          <span className={cn(provider === "codex" ? "truncate" : undefined)}>{triggerLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <TraitsMenuContent
          provider={provider}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          onModelOptionsChange={onModelOptionsChange}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
        />
      </MenuPopup>
    </Menu>
  );
});
