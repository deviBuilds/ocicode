import { assert, describe, expect, it, vi, afterEach } from "vitest";

import { isWindowsPlatform, randomUUID } from "./utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isWindowsPlatform", () => {
  it("matches Windows platform identifiers", () => {
    assert.isTrue(isWindowsPlatform("Win32"));
    assert.isTrue(isWindowsPlatform("Windows"));
    assert.isTrue(isWindowsPlatform("windows_nt"));
  });

  it("does not match darwin", () => {
    assert.isFalse(isWindowsPlatform("darwin"));
  });
});

describe("randomUUID", () => {
  it("uses crypto.randomUUID when available", () => {
    const nativeRandomUuid = vi.fn(() => "native-uuid");
    vi.stubGlobal("crypto", { randomUUID: nativeRandomUuid });

    expect(randomUUID()).toBe("native-uuid");
    expect(nativeRandomUuid).toHaveBeenCalledTimes(1);
  });

  it("falls back to Effect Random when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});

    const value = randomUUID();

    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
