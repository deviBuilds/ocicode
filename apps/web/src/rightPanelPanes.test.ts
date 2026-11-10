import { describe, expect, it } from "vite-plus/test";

import {
  movedRightPanelPaneLayout,
  resolveRightPanelPaneState,
  toggledRightPanelPane,
  withRightPanelPaneState,
  type RightPanelPaneKind,
} from "./rightPanelPanes";
import type { RightPanelSurface, ThreadRightPanelState } from "./rightPanelStore";

const FILES: RightPanelSurface = { id: "files", kind: "files" };
const DIFF: RightPanelSurface = { id: "diff", kind: "diff" };
const browser = (tab: string): RightPanelSurface => ({
  id: `browser:${tab}`,
  kind: "preview",
  resourceId: tab,
});

const panel = (
  surfaces: RightPanelSurface[],
  activeSurfaceId: string | null,
  extra: Partial<ThreadRightPanelState> = {},
): ThreadRightPanelState => ({ isOpen: true, surfaces, activeSurfaceId, ...extra });

/** Applies a change the way the store does. */
const change = (
  current: ThreadRightPanelState,
  next: Partial<ThreadRightPanelState>,
): ThreadRightPanelState => withRightPanelPaneState(current, { ...current, ...next });

const showing = (state: ThreadRightPanelState) => resolveRightPanelPaneState(state).layout;

describe("right panel panes", () => {
  it("keeps an unsplit panel in its old shape", () => {
    const current = panel([FILES, browser("a")], "files");
    expect(change(current, { surfaces: [FILES, browser("a"), browser("b")] })).toEqual(
      panel([FILES, browser("a"), browser("b")], "files"),
    );
  });

  it("shows a newly focused tab's pane beside the ones already showing", () => {
    const next = change(panel([FILES, browser("a")], "files"), { activeSurfaceId: "browser:a" });
    expect(showing(next)).toEqual([["files", "browser"]]);
  });

  it("returns a hidden pane to the tab it was on", () => {
    const split = change(panel([browser("a"), browser("b"), FILES], "browser:a"), {
      activeSurfaceId: "files",
    });
    const hidden = toggledRightPanelPane(
      change(split, { activeSurfaceId: "browser:a" }),
      "browser",
    )!;
    const settled = withRightPanelPaneState(split, hidden);
    expect(settled.activeSurfaceId).toBe("files");
    expect(showing(settled)).toEqual([["files"]]);
    expect(resolveRightPanelPaneState(settled).activeByPane.browser).toBe("browser:a");
  });

  it("closing the focused tab stays in its pane, then in a pane on screen", () => {
    const split = change(panel([DIFF, browser("a"), browser("b"), FILES], "browser:b"), {
      activeSurfaceId: "files",
    });
    const refocused = change(split, { activeSurfaceId: "browser:b" });
    // The flat list would hand focus to the files tab on the right.
    const closedOne = change(refocused, {
      surfaces: [DIFF, browser("a"), FILES],
      activeSurfaceId: "files",
    });
    expect(closedOne.activeSurfaceId).toBe("browser:a");
    // The diff tab on the left is not on screen, so the files pane takes focus.
    const closedPane = change(closedOne, { surfaces: [DIFF, FILES], activeSurfaceId: "diff" });
    expect(closedPane.activeSurfaceId).toBe("files");
    expect(showing(closedPane)).toEqual([["files"]]);
  });

  it("hiding the last pane closes the panel and restores nothing later", () => {
    const current = panel([FILES, DIFF], "files");
    const closed = withRightPanelPaneState(current, toggledRightPanelPane(current, "files")!);
    expect(closed.isOpen).toBe(false);
    const reopened = withRightPanelPaneState(closed, toggledRightPanelPane(closed, "diff")!);
    expect(reopened.isOpen).toBe(true);
    expect(showing(reopened)).toEqual([["diff"]]);
  });

  it("reports a pane with no tab so the caller can open one", () => {
    expect(toggledRightPanelPane(panel([FILES], "files"), "terminal")).toBe(null);
  });

  it.each<{
    name: string;
    layout: RightPanelPaneKind[][];
    move: "left" | "right" | "up" | "down";
    expected: RightPanelPaneKind[][] | null;
  }>([
    {
      name: "right from a shared column makes a new column",
      layout: [["browser", "files"]],
      move: "right",
      expected: [["browser"], ["files"]],
    },
    {
      name: "left joins the neighbouring column",
      layout: [["browser"], ["files"]],
      move: "left",
      expected: [["browser", "files"]],
    },
    {
      name: "a lone pane at the edge stays put",
      layout: [["browser"], ["files"]],
      move: "right",
      expected: null,
    },
    {
      name: "up swaps with the pane above",
      layout: [["browser", "files"]],
      move: "up",
      expected: [["files", "browser"]],
    },
    {
      name: "the top pane cannot move up",
      layout: [["files", "browser"]],
      move: "up",
      expected: null,
    },
  ])("moving a pane: $name", ({ layout, move, expected }) => {
    expect(movedRightPanelPaneLayout(layout, "files", move)).toEqual(expected);
  });
});
