import { appAtomRegistry } from "../rpc/atomRegistry";
import { themeEnvironmentIdAtom } from "../state/primaryEnvironment";
import { themeServerSettingsAtom } from "../state/server";
import {
  BUILD_DEFAULT_THEME,
  getCustomThemes,
  getThemeDefinition,
  installCustomTheme,
  serializeThemeFile,
  singleAppearanceOf,
  subscribeToCustomThemes,
  updateCustomTheme,
} from "../themePalette";
import { hasStoredThemeChoice, refreshTheme, setAppearanceMode, setTheme } from "./useTheme";

const APPLIED_DEFAULT_THEME_STORAGE_PREFIX = "t3code:default-theme-applied:v2:";
const SHIPPED_BUILD_DEFAULT_THEME_STORAGE_KEY = "t3code:build-default-theme-shipped:v1";

/** Include set time so reasserting the same theme still applies. */
export function defaultThemeGeneration(theme: string, setAt: string): string {
  return setAt.length > 0 ? `${theme}@${setAt}` : theme;
}

export function defaultThemeToApply(input: {
  readonly environmentId: string | null;
  readonly defaultTheme: string;
  readonly defaultThemeSetAt: string;
  readonly appliedGeneration: string | null;
  readonly resolves: boolean;
}): string | null {
  if (input.environmentId === null || input.defaultTheme.length === 0) return null;
  const generation = defaultThemeGeneration(input.defaultTheme, input.defaultThemeSetAt);
  if (input.appliedGeneration === generation) return null;
  // The setting and the palette it names arrive independently, so an id that
  // does not resolve yet is not a failure -- adoption re-checks when the
  // published set changes.
  if (!input.resolves) return null;
  return generation;
}

function readAppliedGeneration(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeAppliedGeneration(storageKey: string, generation: string): void {
  try {
    window.localStorage.setItem(storageKey, generation);
  } catch {}
}

function adoptDefaultTheme(): void {
  if (typeof window === "undefined") return;
  const environmentId = appAtomRegistry.get(themeEnvironmentIdAtom);
  if (environmentId === null) return;
  const { defaultTheme, defaultThemeSetAt } = appAtomRegistry.get(themeServerSettingsAtom);
  const definition = getThemeDefinition(defaultTheme);
  const storageKey = `${APPLIED_DEFAULT_THEME_STORAGE_PREFIX}${environmentId}`;
  const generation = defaultThemeToApply({
    environmentId,
    defaultTheme,
    defaultThemeSetAt,
    appliedGeneration: readAppliedGeneration(storageKey),
    resolves: definition !== null,
  });
  if (generation === null || definition === null) return;

  // A single-appearance theme needs both preference and appearance writes to take effect.
  if (!setTheme(defaultTheme)) return;
  const half = singleAppearanceOf(definition);
  // Only record adoption after both writes succeed, so an appearance failure remains retryable.
  if (half !== null && !setAppearanceMode(half)) return;
  writeAppliedGeneration(storageKey, generation);
}

/** The installed copy follows a new build's palette only while it still matches what a build installed. */
export function buildDefaultThemeNeedsUpdate(input: {
  readonly installed: string | null;
  readonly lastShipped: string | null;
  readonly shipped: string;
}): boolean {
  return (
    input.installed !== null &&
    input.installed === input.lastShipped &&
    input.lastShipped !== input.shipped
  );
}

function updateBuildDefaultTheme(): void {
  if (typeof window === "undefined") return;
  try {
    const installed = getCustomThemes().find((theme) => theme.id === BUILD_DEFAULT_THEME.id);
    const shipped = serializeThemeFile(BUILD_DEFAULT_THEME);
    const needsUpdate = buildDefaultThemeNeedsUpdate({
      installed: installed ? serializeThemeFile(installed) : null,
      lastShipped: window.localStorage.getItem(SHIPPED_BUILD_DEFAULT_THEME_STORAGE_KEY),
      shipped,
    });
    if (!needsUpdate) return;
    updateCustomTheme(BUILD_DEFAULT_THEME);
    window.localStorage.setItem(SHIPPED_BUILD_DEFAULT_THEME_STORAGE_KEY, shipped);
    refreshTheme();
  } catch {}
}

/** A browser with no theme choice yet starts on the theme this build ships; any later choice sticks. */
function adoptBuildDefaultTheme(): void {
  if (hasStoredThemeChoice()) return;
  try {
    if (getThemeDefinition(BUILD_DEFAULT_THEME.id) === null) {
      installCustomTheme(BUILD_DEFAULT_THEME);
      window.localStorage.setItem(
        SHIPPED_BUILD_DEFAULT_THEME_STORAGE_KEY,
        serializeThemeFile(BUILD_DEFAULT_THEME),
      );
    }
  } catch {
    return;
  }
  if (!setTheme(BUILD_DEFAULT_THEME.id)) return;
  const half = singleAppearanceOf(BUILD_DEFAULT_THEME);
  if (half !== null) setAppearanceMode(half);
}

/**
 * Applies the theme environment's default theme once per generation. Start it after the
 * environment theme sync so a first-run client adopting the environment's own theme finds it
 * already in the library; it re-checks when published or custom palettes change, so a theme
 * that resolves late still applies.
 */
export function startDefaultThemeAdoption(): () => void {
  const unsubscribes = [
    appAtomRegistry.subscribe(themeEnvironmentIdAtom, adoptDefaultTheme),
    appAtomRegistry.subscribe(themeServerSettingsAtom, adoptDefaultTheme),
    subscribeToCustomThemes(adoptDefaultTheme),
  ];
  updateBuildDefaultTheme();
  // Before the environment default, so one that is set still wins.
  adoptBuildDefaultTheme();
  adoptDefaultTheme();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
