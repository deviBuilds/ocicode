import { describe, expect, it } from "vitest";

import {
  MIN_CHAT_COLUMN_WIDTH,
  MIN_CHAT_COLUMN_WIDTH_WITH_DIFF,
  minChatColumnWidthForShell,
  shouldAcceptMainSidebarWidth,
} from "./chatShellLayout";

describe("minChatColumnWidthForShell", () => {
  it("uses the wider minimum when inline diff is closed", () => {
    expect(minChatColumnWidthForShell(false)).toBe(MIN_CHAT_COLUMN_WIDTH);
  });

  it("uses the narrower minimum when inline diff is open", () => {
    expect(minChatColumnWidthForShell(true)).toBe(MIN_CHAT_COLUMN_WIDTH_WITH_DIFF);
  });
});

describe("shouldAcceptMainSidebarWidth", () => {
  it("accepts widths that preserve the default chat column minimum", () => {
    expect(shouldAcceptMainSidebarWidth({ chatColumnWidth: 761, diffOpen: false })).toBe(true);
  });

  it("rejects widths that squeeze the default chat column below the minimum", () => {
    expect(shouldAcceptMainSidebarWidth({ chatColumnWidth: 759, diffOpen: false })).toBe(false);
  });

  it("accepts widths that preserve the narrower diff-open minimum", () => {
    expect(shouldAcceptMainSidebarWidth({ chatColumnWidth: 640, diffOpen: true })).toBe(true);
  });

  it("rejects widths that squeeze the diff-open chat column below the minimum", () => {
    expect(shouldAcceptMainSidebarWidth({ chatColumnWidth: 639, diffOpen: true })).toBe(false);
  });
});
