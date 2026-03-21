import { useCallback, useEffect, useSyncExternalStore } from "react";
import { makeStorageKey } from "@ocicode/shared/branding";

export type ColorTint = "violet" | "neutral";

const STORAGE_KEY = makeStorageKey("color-tint");
const VALID_TINTS: ReadonlySet<string> = new Set<ColorTint>(["violet", "neutral"]);

let listeners: Array<() => void> = [];
let lastTint: ColorTint | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

export function resolveStoredColorTint(raw: string | null): ColorTint {
  if (raw && VALID_TINTS.has(raw)) return raw as ColorTint;
  return "neutral";
}

function getStored(): ColorTint {
  if (typeof localStorage === "undefined") {
    return "neutral";
  }
  return resolveStoredColorTint(localStorage.getItem(STORAGE_KEY));
}

function applyTint(tint: ColorTint) {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  root.classList.remove("tint-violet", "tint-neutral");
  root.classList.add(`tint-${tint}`);
}

// Apply immediately on module load to prevent flash
applyTint(getStored());

function getSnapshot(): ColorTint {
  const tint = getStored();
  if (lastTint === tint) return lastTint;
  lastTint = tint;
  return lastTint;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const handleStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      applyTint(getStored());
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useColorTint() {
  const tint = useSyncExternalStore(subscribe, getSnapshot);

  const setTint = useCallback((next: ColorTint) => {
    localStorage.setItem(STORAGE_KEY, next);
    applyTint(next);
    emitChange();
  }, []);

  useEffect(() => {
    applyTint(tint);
  }, [tint]);

  return { tint, setTint } as const;
}
