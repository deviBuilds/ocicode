import { describe, expect, it } from "vitest";

import {
  MAIN_SIDEBAR_MIN_WIDTH,
  MIN_CHAT_SHELL_CONTENT_WIDTH,
  shouldAcceptMainSidebarWidth,
} from "./chatShellLayout";

describe("shouldAcceptMainSidebarWidth", () => {
  it("accepts widths that preserve the minimum chat shell content width", () => {
    expect(
      shouldAcceptMainSidebarWidth({
        nextSidebarWidth: 320,
        shellWidth: 320 + MIN_CHAT_SHELL_CONTENT_WIDTH,
      }),
    ).toBe(true);
  });

  it("rejects widths that squeeze the main content below the minimum", () => {
    expect(
      shouldAcceptMainSidebarWidth({
        nextSidebarWidth: 320,
        shellWidth: 320 + MIN_CHAT_SHELL_CONTENT_WIDTH - 1,
      }),
    ).toBe(false);
  });

  it("keeps the resize range valid on a 1024px desktop window", () => {
    expect(
      shouldAcceptMainSidebarWidth({
        nextSidebarWidth: MAIN_SIDEBAR_MIN_WIDTH,
        shellWidth: 1024,
      }),
    ).toBe(true);
  });
});
