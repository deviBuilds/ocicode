import { type ModelSlug, type ProviderKind } from "@ocicode/contracts";
import { normalizeModelSlug } from "@ocicode/shared/model";
import { memo, useState } from "react";
import { ChevronDownIcon } from "lucide-react";

import { type Icon, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { cn } from "~/lib/utils";
import { PROVIDER_OPTIONS } from "~/session-logic";

const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => option.available);
const PROVIDER_ICON_BY_PROVIDER: Record<ProviderKind, Icon> = { codex: OpenAI };

function resolveModelForProviderPicker(
  provider: ProviderKind,
  value: string,
  options: ReadonlyArray<{ slug: string; name: string }>,
): ModelSlug | null {
  const trimmedValue = value.trim();
  if (!trimmedValue) return null;

  const direct = options.find((option) => option.slug === trimmedValue);
  if (direct) return direct.slug;

  const byName = options.find((option) => option.name.toLowerCase() === trimmedValue.toLowerCase());
  if (byName) return byName.slug;

  const normalized = normalizeModelSlug(trimmedValue, provider);
  if (!normalized) return null;

  const resolved = options.find((option) => option.slug === normalized);
  return resolved?.slug ?? null;
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  compact?: boolean;
  disabled?: boolean;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const selectedProviderOptions = props.modelOptionsByProvider[props.provider];
  const selectedModelLabel =
    selectedProviderOptions.find((option) => option.slug === props.model)?.name ?? props.model;
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.provider];

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className={cn(
              "min-w-0 shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80",
              props.compact ? "max-w-[10.5rem]" : "sm:px-3",
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 items-center gap-2",
            props.compact ? "max-w-[9rem]" : undefined,
          )}
        >
          <ProviderIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />
          <span className="truncate">{selectedModelLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
          const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
          const isDisabledByProviderLock =
            props.lockedProvider !== null && props.lockedProvider !== option.value;
          return (
            <MenuSub key={option.value}>
              <MenuSubTrigger disabled={isDisabledByProviderLock}>
                <OptionIcon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground/85"
                />
                {option.label}
              </MenuSubTrigger>
              <MenuSubPopup className="[--available-height:min(24rem,70vh)]" sideOffset={4}>
                <MenuGroup>
                  <MenuRadioGroup
                    value={props.provider === option.value ? props.model : ""}
                    onValueChange={(value) => {
                      if (props.disabled || isDisabledByProviderLock || !value) return;
                      const resolvedModel = resolveModelForProviderPicker(
                        option.value,
                        value,
                        props.modelOptionsByProvider[option.value],
                      );
                      if (!resolvedModel) return;
                      props.onProviderModelChange(option.value, resolvedModel);
                      setIsMenuOpen(false);
                    }}
                  >
                    {props.modelOptionsByProvider[option.value].map((modelOption) => (
                      <MenuRadioItem
                        key={`${option.value}:${modelOption.slug}`}
                        value={modelOption.slug}
                        onClick={() => setIsMenuOpen(false)}
                      >
                        {modelOption.name}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
              </MenuSubPopup>
            </MenuSub>
          );
        })}
      </MenuPopup>
    </Menu>
  );
});
