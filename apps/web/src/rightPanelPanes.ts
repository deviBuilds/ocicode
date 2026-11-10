import type { RightPanelKind, RightPanelSurface, ThreadRightPanelState } from "./rightPanelStore";

export const RIGHT_PANEL_PANE_KINDS = ["browser", "terminal", "files", "diff", "other"] as const;
export type RightPanelPaneKind = (typeof RIGHT_PANEL_PANE_KINDS)[number];
/** Showing panes as columns, left to right, each top to bottom. */
export type RightPanelPaneLayout = ReadonlyArray<ReadonlyArray<RightPanelPaneKind>>;
export type RightPanelPaneMove = "left" | "right" | "up" | "down";
/** Flex shares: `height` within a column, `width` for the column a pane leads. Unset is 1. */
export type RightPanelPaneSizes = Partial<
  Record<RightPanelPaneKind, { readonly width?: number; readonly height?: number }>
>;

export interface RightPanelPane {
  readonly kind: RightPanelPaneKind;
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
  readonly activeSurface: RightPanelSurface;
}

type ActiveByPane = Partial<Record<RightPanelPaneKind, string>>;

/** Each surface assumes one of its kind on screen, so a pane holds every tab of one kind. */
function rightPanelPaneKindOf(kind: RightPanelKind): RightPanelPaneKind {
  switch (kind) {
    case "preview":
      return "browser";
    case "terminal":
      return "terminal";
    case "files":
    case "file":
      return "files";
    case "diff":
      return "diff";
    default:
      return "other";
  }
}

function surfacesOfPane(
  surfaces: ReadonlyArray<RightPanelSurface>,
  kind: RightPanelPaneKind,
): RightPanelSurface[] {
  return surfaces.filter((surface) => rightPanelPaneKindOf(surface.kind) === kind);
}

function focusedPaneKind(
  state: Pick<ThreadRightPanelState, "surfaces" | "activeSurfaceId">,
): RightPanelPaneKind | null {
  const focused = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
  return focused ? rightPanelPaneKindOf(focused.kind) : null;
}

/** Without stored choices only the focused tab's pane shows, and other panes rest on their last tab. */
function defaultPaneState(state: Pick<ThreadRightPanelState, "surfaces" | "activeSurfaceId">): {
  layout: RightPanelPaneKind[][];
  activeByPane: ActiveByPane;
} {
  const activeByPane: ActiveByPane = {};
  for (const surface of state.surfaces) {
    activeByPane[rightPanelPaneKindOf(surface.kind)] = surface.id;
  }
  const focused = focusedPaneKind(state);
  if (focused !== null && state.activeSurfaceId !== null) {
    activeByPane[focused] = state.activeSurfaceId;
  }
  return { layout: focused === null ? [] : [[focused]], activeByPane };
}

function sanitizedLayout(
  layout: RightPanelPaneLayout,
  present: ReadonlySet<RightPanelPaneKind>,
): RightPanelPaneKind[][] {
  const seen = new Set<RightPanelPaneKind>();
  return layout
    .map((column) =>
      column.filter((kind) => {
        if (!present.has(kind) || seen.has(kind)) return false;
        seen.add(kind);
        return true;
      }),
    )
    .filter((column) => column.length > 0);
}

export function resolveRightPanelPaneState(
  state: Pick<
    ThreadRightPanelState,
    "surfaces" | "activeSurfaceId" | "paneLayout" | "paneActiveSurfaceIds"
  >,
): { layout: RightPanelPaneKind[][]; activeByPane: ActiveByPane } {
  const defaults = defaultPaneState(state);
  const kindById = new Map<string, RightPanelPaneKind>(
    state.surfaces.map((surface) => [surface.id, rightPanelPaneKindOf(surface.kind)] as const),
  );
  const activeByPane = { ...defaults.activeByPane };
  const focused = focusedPaneKind(state);
  for (const kind of RIGHT_PANEL_PANE_KINDS) {
    const stored = state.paneActiveSurfaceIds?.[kind];
    if (stored !== undefined && kind !== focused && kindById.get(stored) === kind) {
      activeByPane[kind] = stored;
    }
  }
  return {
    layout: sanitizedLayout(state.paneLayout ?? defaults.layout, new Set(kindById.values())),
    activeByPane,
  };
}

/** The panes to draw. Empty when no pane is showing. */
export function resolveRightPanelPanes(
  state: Pick<
    ThreadRightPanelState,
    "surfaces" | "activeSurfaceId" | "paneLayout" | "paneActiveSurfaceIds"
  >,
): RightPanelPane[][] {
  const { layout, activeByPane } = resolveRightPanelPaneState(state);
  return layout
    .map((column) =>
      column.flatMap((kind): RightPanelPane[] => {
        const surfaces = surfacesOfPane(state.surfaces, kind);
        const activeSurface = surfaces.find((surface) => surface.id === activeByPane[kind]);
        return activeSurface ? [{ kind, surfaces, activeSurface }] : [];
      }),
    )
    .filter((column) => column.length > 0);
}

function layoutsEqual(left: RightPanelPaneLayout, right: RightPanelPaneLayout): boolean {
  return (
    left.length === right.length &&
    left.every(
      (column, index) =>
        column.length === right[index]!.length &&
        column.every((kind, row) => kind === right[index]![row]),
    )
  );
}

/**
 * Carries pane choices across any change to the tabs: a focused tab's pane shows, a closed tab
 * hands over to its neighbour in the same pane, and emptied panes go. Stores only what differs
 * from the default, so a panel that never split keeps its old shape.
 */
export function withRightPanelPaneState(
  current: ThreadRightPanelState,
  next: ThreadRightPanelState,
): ThreadRightPanelState {
  if (next === current) return current;
  const before = resolveRightPanelPaneState(current);
  const kindById = new Map<string, RightPanelPaneKind>(
    next.surfaces.map((surface) => [surface.id, rightPanelPaneKindOf(surface.kind)] as const),
  );
  const present = new Set(kindById.values());

  const activeByPane: ActiveByPane = {};
  // Panes on screen keep their tab; one that never showed has no choice to carry.
  const onScreen = Object.fromEntries(
    before.layout.flat().map((kind) => [kind, before.activeByPane[kind]] as const),
  ) as ActiveByPane;
  const chosen =
    next.paneActiveSurfaceIds === current.paneActiveSurfaceIds
      ? { ...next.paneActiveSurfaceIds, ...onScreen }
      : { ...onScreen, ...next.paneActiveSurfaceIds };
  for (const kind of present) {
    const remaining = surfacesOfPane(next.surfaces, kind);
    const wanted = chosen[kind];
    if (wanted !== undefined && kindById.get(wanted) === kind) {
      activeByPane[kind] = wanted;
      continue;
    }
    const closedIndex = surfacesOfPane(current.surfaces, kind).findIndex(
      (surface) => surface.id === wanted,
    );
    activeByPane[kind] = (
      closedIndex < 0
        ? remaining[remaining.length - 1]!
        : remaining[Math.min(closedIndex, remaining.length - 1)]!
    ).id;
  }

  let layout = sanitizedLayout(
    next.paneLayout !== undefined && next.paneLayout !== current.paneLayout
      ? next.paneLayout
      : before.layout,
    present,
  );

  let activeSurfaceId = next.activeSurfaceId;
  const closedFocus = current.surfaces.find((surface) => surface.id === current.activeSurfaceId);
  if (closedFocus !== undefined && !kindById.has(closedFocus.id) && activeSurfaceId !== null) {
    // The flat list's neighbour may sit in another pane; stay in this one, or in one on screen.
    const closedKind = rightPanelPaneKindOf(closedFocus.kind);
    const showing = layout.flat();
    const landedKind = kindById.get(activeSurfaceId);
    if (present.has(closedKind)) {
      activeSurfaceId = activeByPane[closedKind]!;
    } else if (showing.length > 0 && (landedKind === undefined || !showing.includes(landedKind))) {
      activeSurfaceId = activeByPane[showing[0]!]!;
    }
  }

  const focused = activeSurfaceId === null ? undefined : kindById.get(activeSurfaceId);
  if (focused !== undefined && activeSurfaceId !== null) {
    activeByPane[focused] = activeSurfaceId;
    const showing = layout.some((column) => column.includes(focused));
    if (!showing && (next.isOpen || activeSurfaceId !== current.activeSurfaceId)) {
      layout = [...layout.slice(0, -1), [...(layout.at(-1) ?? []), focused]];
    }
  }

  const defaults = defaultPaneState({ surfaces: next.surfaces, activeSurfaceId });
  const storedActive = Object.fromEntries(
    Object.entries(activeByPane).filter(
      ([kind, id]) => defaults.activeByPane[kind as RightPanelPaneKind] !== id,
    ),
  ) as ActiveByPane;
  const paneLayout = layoutsEqual(layout, defaults.layout) ? undefined : layout;
  const paneActiveSurfaceIds = Object.keys(storedActive).length === 0 ? undefined : storedActive;

  const unchanged =
    activeSurfaceId === next.activeSurfaceId &&
    (paneLayout === undefined
      ? next.paneLayout === undefined
      : next.paneLayout !== undefined && layoutsEqual(paneLayout, next.paneLayout)) &&
    JSON.stringify(paneActiveSurfaceIds) === JSON.stringify(next.paneActiveSurfaceIds);
  if (unchanged) return next;

  const {
    paneLayout: _layout,
    paneActiveSurfaceIds: _active,
    ...rest
  } = { ...next, activeSurfaceId };
  return {
    ...rest,
    ...(paneLayout === undefined ? {} : { paneLayout }),
    ...(paneActiveSurfaceIds === undefined ? {} : { paneActiveSurfaceIds }),
  };
}

/** Shows or hides one pane. Null when the pane has no tab yet, so the caller opens one. */
export function toggledRightPanelPane(
  current: ThreadRightPanelState,
  kind: RightPanelPaneKind,
): ThreadRightPanelState | null {
  const { layout, activeByPane } = resolveRightPanelPaneState(current);
  if (current.isOpen && layout.some((column) => column.includes(kind))) {
    const remaining = layout
      .map((column) => column.filter((entry) => entry !== kind))
      .filter((column) => column.length > 0);
    // An emptied layout, unlike a hidden panel, restores nothing when another pane opens.
    if (remaining.length === 0) return { ...current, isOpen: false, paneLayout: [] };
    const focused = focusedPaneKind(current);
    const nextFocus = focused === null || focused === kind ? remaining[0]![0]! : focused;
    return {
      ...current,
      paneLayout: remaining,
      paneActiveSurfaceIds: activeByPane,
      activeSurfaceId: activeByPane[nextFocus] ?? current.activeSurfaceId,
    };
  }
  const tab = activeByPane[kind];
  if (tab === undefined) return null;
  return { ...current, isOpen: true, activeSurfaceId: tab, paneActiveSurfaceIds: activeByPane };
}

/** Where `move` would put the pane, or null when it has nowhere to go. */
export function movedRightPanelPaneLayout(
  layout: RightPanelPaneLayout,
  kind: RightPanelPaneKind,
  move: RightPanelPaneMove,
): RightPanelPaneKind[][] | null {
  const columnIndex = layout.findIndex((column) => column.includes(kind));
  if (columnIndex < 0) return null;
  const column = layout[columnIndex]!;
  const row = column.indexOf(kind);
  if (move === "up" || move === "down") {
    const target = move === "up" ? row - 1 : row + 1;
    if (target < 0 || target >= column.length) return null;
    const reordered = [...column];
    reordered[row] = column[target]!;
    reordered[target] = kind;
    return layout.map((entry, index) => (index === columnIndex ? reordered : [...entry]));
  }
  const targetIndex = move === "left" ? columnIndex - 1 : columnIndex + 1;
  const hasTarget = targetIndex >= 0 && targetIndex < layout.length;
  // A pane alone at the edge has no further column to make.
  if (!hasTarget && column.length === 1) return null;
  const without = layout.map((entry) => entry.filter((entry_) => entry_ !== kind));
  if (hasTarget) without[targetIndex] = [...without[targetIndex]!, kind];
  else if (move === "left") without.unshift([kind]);
  else without.push([kind]);
  return without.filter((entry) => entry.length > 0);
}

export function movedRightPanelPane(
  current: ThreadRightPanelState,
  kind: RightPanelPaneKind,
  move: RightPanelPaneMove,
): ThreadRightPanelState {
  const { layout, activeByPane } = resolveRightPanelPaneState(current);
  const paneLayout = movedRightPanelPaneLayout(layout, kind, move);
  return paneLayout === null
    ? current
    : { ...current, paneLayout, paneActiveSurfaceIds: activeByPane };
}
