import { describe, expect, it } from "vite-plus/test";

import buildDefaultThemeFile from "../buildDefaultTheme.json";
import { BUILD_DEFAULT_THEME, THEME_COLOR_ROLES } from "../themePalette";
import {
  buildDefaultThemeNeedsUpdate,
  defaultThemeGeneration,
  defaultThemeToApply,
  themeSetsOwnMode,
} from "./useDefaultTheme";

const BASE = {
  environmentId: "env-1",
  defaultTheme: "nightfall",
  defaultThemeSetAt: "2026-08-28T00:00:00.000Z",
  appliedGeneration: null,
  resolves: true,
} as const;

describe("default theme adoption", () => {
  it("does not replay a generation it already applied", () => {
    const generation = defaultThemeGeneration(BASE.defaultTheme, BASE.defaultThemeSetAt);
    expect(defaultThemeToApply({ ...BASE, appliedGeneration: generation })).toBe(null);
  });

  it("applies the same theme again when the environment re-sets it", () => {
    const applied = defaultThemeGeneration(BASE.defaultTheme, "2026-08-28T00:00:00.000Z");
    const next = defaultThemeToApply({
      ...BASE,
      defaultThemeSetAt: "2026-08-29T00:00:00.000Z",
      appliedGeneration: applied,
    });
    expect(next).not.toBe(null);
    expect(next).not.toBe(applied);
  });

  it("applies the stock theme only when the environment set it", () => {
    expect(defaultThemeToApply({ ...BASE, defaultTheme: "", defaultThemeSetAt: "" })).toBe(null);
    expect(defaultThemeToApply({ ...BASE, defaultTheme: "" })).not.toBe(null);
  });

  it("ships a build default that sets every color itself", () => {
    expect(Object.keys(buildDefaultThemeFile.colors).toSorted()).toEqual(
      [...THEME_COLOR_ROLES].toSorted(),
    );
    expect(BUILD_DEFAULT_THEME.colors.canvas).toBe(buildDefaultThemeFile.colors.canvas);
  });

  it.each([
    {
      name: "an untouched copy follows a new build",
      installed: "v1",
      lastShipped: "v1",
      update: true,
    },
    { name: "an edited copy is kept", installed: "edited", lastShipped: "v1", update: false },
    {
      name: "a copy no build installed is kept",
      installed: "v1",
      lastShipped: null,
      update: false,
    },
    {
      name: "a removed copy is not reinstalled",
      installed: null,
      lastShipped: "v1",
      update: false,
    },
    {
      name: "the current palette is left alone",
      installed: "v2",
      lastShipped: "v2",
      update: false,
    },
  ])("$name", ({ installed, lastShipped, update }) => {
    expect(buildDefaultThemeNeedsUpdate({ installed, lastShipped, shipped: "v2" })).toBe(update);
  });
});

it("lets a theme set its own mode only when no mode was set with it or after it", () => {
  const theme = "2026-11-13T10:00:00.000Z";
  const set = (defaultAppearance: string, defaultAppearanceSetAt: string) =>
    themeSetsOwnMode({ defaultThemeSetAt: theme, defaultAppearance, defaultAppearanceSetAt });
  expect(set("", "")).toBe(true);
  expect(set("dark", "2026-11-13T09:00:00.000Z")).toBe(true);
  expect(set("dark", theme)).toBe(false);
  expect(set("light", "2026-11-13T11:00:00.000Z")).toBe(false);
});
