import { describe, expect, it } from "vitest";

import { resolveStoredColorTint } from "./useColorTint";

describe("resolveStoredColorTint", () => {
  it("defaults to neutral when no value is stored", () => {
    expect(resolveStoredColorTint(null)).toBe("neutral");
  });

  it("accepts the neutral tint", () => {
    expect(resolveStoredColorTint("neutral")).toBe("neutral");
  });

  it("accepts the violet tint", () => {
    expect(resolveStoredColorTint("violet")).toBe("violet");
  });

  it("falls back to neutral for invalid values", () => {
    expect(resolveStoredColorTint("blue" as never)).toBe("neutral");
  });
});
