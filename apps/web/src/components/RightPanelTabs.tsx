import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  useProjects,
  useQuietThreadShell,
  useServerConfigs,
  useThreadShells,
} from "~/state/entities";
import {
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import type {
  ContextMenuItem,
  EnvironmentId,
  PreviewSessionSnapshot,
  ProjectId,
  PullRequestState,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToHorizontalAxis } from "@dnd-kit/modifiers";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Smartphone,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  EyeOff,
  FileDiff,
  Files,
  Globe2,
  MessagesSquare,
  Plus,
  TerminalSquare,
  Volume2Icon,
  VolumeOffIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import { isElectron } from "~/env";
import type { DesktopPreviewOverlay } from "~/previewStateStore";
import type { RightPanelSurface } from "~/rightPanelStore";
import {
  movedRightPanelPaneLayout,
  type RightPanelPane,
  type RightPanelPaneKind,
  type RightPanelPaneMove,
  type RightPanelPaneSizes,
} from "~/rightPanelPanes";
import { cn } from "~/lib/utils";
import { resolveShortcutCommand, type ShortcutMatchContext } from "~/keybindings";
import { readLocalApi } from "~/localApi";
import { useStableCallback } from "~/hooks/useStableCallback";
import { Button } from "~/components/ui/button";
import { AndroidIcon, AppleIcon } from "~/components/Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { Kbd } from "~/components/ui/kbd";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import { ScrollArea } from "~/components/ui/scroll-area";
import { PanelTabCloseButton } from "~/components/ui/panel-tab-close-button";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { useTheme } from "~/hooks/useTheme";
import { useDeviceState } from "~/state/device";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import {
  newestPullRequestSummary,
  pullRequestEnvironment,
  useSharedPullRequestSummary,
} from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import { FaviconImage } from "./preview/PreviewFaviconIcon";
import { previewBridge } from "./preview/previewBridge";
import { dispatchPreviewAction } from "./preview/previewActionBus";
import { preventThumbButtonFocus, takeThumbButtonNavigation } from "./preview/thumbButtons";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";
import { surfaceShortcutKey } from "~/lib/surfaceShortcutKey";

export interface RightPanelTabsProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  open?: boolean;
  keybindings: ResolvedKeybindingsConfig;
  getShortcutContext: () => ShortcutMatchContext;
  widthStorageKey?: string;
  defaultWidth?: number;
  inlineSize?: PreviewPanelInlineSize;
  layoutControls?: ReactNode;
  surfaces: readonly RightPanelSurface[];
  environmentId: EnvironmentId | null;
  activeSurfaceId: string | null;
  pendingSurfaceIds: ReadonlySet<string>;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  /** Maps server-local session ids to desktop runtime ids; session ids cannot address desktop operations. */
  previewRuntimeTabId?: ((tabId: string) => string) | undefined;
  terminalLabelsById: ReadonlyMap<string, string>;
  onActivate: (surface: RightPanelSurface) => void;
  onRenameDevice?: (surfaceId: string, title: string) => void;
  onCloseSurface: (surface: RightPanelSurface) => void;
  onCloseOtherSurfaces: (surface: RightPanelSurface) => void;
  onCloseSurfacesToRight: (surface: RightPanelSurface) => void;
  onCloseAllSurfaces: () => void;
  onMoveSurface?: (surfaceId: string, toIndex: number) => void;
  onCopyFilePath: (relativePath: string) => void;
  onAddBrowser: () => void;
  /** Keep separate from the DOM click handler so a MouseEvent cannot become a profile id. */
  onAddBrowserInProfile: (profileId: string) => void;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddPullRequests: () => void;
  onAddDevice: () => void;
  /** Absent where side chats are not offered. */
  onAddSideChat?: (() => void) | undefined;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  pullRequestsAvailable: boolean;
  deviceAvailable: boolean;
  sideChatAvailable?: boolean;
  /** Overrides the default reason while side chats are available but cannot start. */
  sideChatDisabledReason?: string | null;
  pullRequestStatusSeeds?: Readonly<Record<string, PullRequestTabStatusSeed>>;
  /** Set when this strip is one pane among several inside a shell its parent draws. */
  pane?: RightPanelPaneFrame;
  children: ReactNode;
}

interface RightPanelPaneFrame {
  /** The panel's top-left corner sits under the window controls of a collapsed sidebar. */
  readonly topLeft: boolean;
  /** The panel's top-right corner hosts the window's own controls. */
  readonly topRight: boolean;
  /** Only the focused pane answers panel-wide shortcuts. */
  readonly focused: boolean;
  readonly className: string;
  readonly style: CSSProperties;
  readonly controls: ReactNode;
  readonly onFocus: () => void;
}

export interface PullRequestTabStatus {
  projectId: string;
  repository: string;
  number: number;
  state: PullRequestState;
  isDraft: boolean;
}

export type PullRequestTabStatusSeed = Pick<PullRequestTabStatus, "state" | "isDraft">;

function shouldOpenDefaultBrowserProfileFromMenuClick(pointerType: string | undefined): boolean {
  return pointerType !== "touch";
}

const SURFACE_DISABLED_REASONS = {
  browser: "Browser previews are only available in the T3 Code desktop app.",
  terminal: "Terminal surfaces are only available from a project thread.",
  files: "Files are only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "This thread's branch has no pull request yet.",
  pullRequests: "No linked pull requests are available for this thread.",
  device: "Devices are only available from a thread.",
  sideChat: "Side chats start after the first message.",
} as const;

// Closed keepMounted popups must stop blocking shortcuts once their exit transition ends.
const LAUNCHER_SHORTCUT_BLOCKING_LAYERS = [
  "dialog-popup",
  "alert-dialog-popup",
  "command-dialog-popup",
  "menu-popup",
  "select-popup",
  "popover-popup",
  "combobox-popup",
  "autocomplete-popup",
]
  .map((slot) => `[data-slot="${slot}"]:is([data-open],[data-ending-style])`)
  .join(",");

const SURFACE_UNAVAILABLE_HINTS = {
  browser: "Only available in the desktop app.",
  terminal: "Available when a project is open.",
  files: "Available when a project is open.",
  diff: "Available for Git repositories.",
  pullRequest: "No pull request on this branch yet.",
  pullRequests: "No linked pull requests available.",
  device: "Available from a thread.",
  sideChat: "Available after the first message.",
} as const;

type TabContextMenuAction =
  | "rename"
  | "copy-path"
  | "toggle-mute"
  | "close"
  | "close-others"
  | "close-to-right"
  | "close-all";

const TAB_SCROLL_EDGE_TOLERANCE = 1;
const ADD_SURFACE_HOLD_MS = 450;
const TAB_DRAG_MODIFIERS = [restrictToHorizontalAxis, restrictToFirstScrollableAncestor];

function tabScrollViewport(root: HTMLDivElement | null): HTMLDivElement | null {
  return root?.querySelector<HTMLDivElement>('[data-slot="scroll-area-viewport"]') ?? null;
}

function previewTabIdOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
): string | null {
  if (surface.kind !== "preview" || !surface.resourceId) return null;
  return sessions[surface.resourceId]?.tabId ?? null;
}

/**
 * Stays disabled until desktop overlay state arrives: a server session id can
 * resolve while the preview manager's createTab is still in flight, and muting
 * then fails with a PreviewTabNotFoundError nothing surfaces to the user.
 */
function tabMuteMenuItem(input: {
  overlay: DesktopPreviewOverlay | null;
  canResolveRuntimeTabId: boolean;
}): { label: string; disabled: boolean } {
  const muted = input.overlay?.audioMuted ?? false;
  return {
    label: muted ? "Unmute tab" : "Mute tab",
    disabled: input.overlay === null || !input.canResolveRuntimeTabId,
  };
}

type TabAudioState = "none" | "audible" | "muted";

function tabAudioState(overlay: DesktopPreviewOverlay | null): TabAudioState {
  if (!overlay?.audible) return "none";
  return overlay.audioMuted ? "muted" : "audible";
}

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
> &
  Partial<Pick<KeyboardEvent, "code" | "getModifierState">>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  const key = surfaceShortcutKey(event);
  return (
    actions.find((action) => action.available && action.shortcut.toLowerCase() === key) ?? null
  );
}

/** Skip contenteditable=false islands to find their editable host, matching the composer typing guard. */
export function surfaceShortcutTargetsTypingContext(
  target: { closest(selectors: string): unknown } | null,
): boolean {
  return (
    target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !=
    null
  );
}

function DisabledReasonTooltip(props: { reason: string; trigger: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger} />
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function SurfaceMenuItem(props: {
  available: boolean;
  disabledReason?: string;
  shortcut: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const item = (
    <MenuItem
      className={!props.available ? "data-disabled:pointer-events-auto" : undefined}
      onClick={props.onClick}
      disabled={!props.available}
      aria-keyshortcuts={props.shortcut}
    >
      {props.children}
      <MenuShortcut>{props.shortcut}</MenuShortcut>
    </MenuItem>
  );
  if (props.available || !props.disabledReason) return item;
  return <DisabledReasonTooltip reason={props.disabledReason} trigger={item} />;
}

function RightPanelEmptyState(props: {
  onAddBrowser: () => void;
  onAddBrowserInProfile: (profileId: string) => void;
  browserProfiles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  onAddTerminal: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddPullRequests: () => void;
  onAddDevice: () => void;
  /** Absent where side chats are not offered. */
  onAddSideChat?: (() => void) | undefined;
  browserAvailable: boolean;
  terminalAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  pullRequestsAvailable: boolean;
  deviceAvailable: boolean;
  sideChatAvailable: boolean;
  sideChatDisabledReason: string | null;
}) {
  const [highlight, setHighlight] = useState(-1);

  const actions = [
    {
      label: "Browser",
      icon: Globe2,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: "Terminal",
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.terminal,
      onClick: props.onAddTerminal,
    },
    {
      label: "Files",
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.files,
      onClick: props.onAddFiles,
    },
    {
      label: "Diff",
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: "Pull request",
      icon: PullRequestGlyph.pullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequest,
      onClick: props.onAddPullRequest,
    },
    {
      label: "Linked pull requests",
      icon: PullRequestGlyph.link,
      shortcut: "L",
      available: props.pullRequestsAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.pullRequests,
      onClick: props.onAddPullRequests,
    },
    {
      label: "Device",
      description: "Watch an iOS Simulator or Android Emulator.",
      icon: Smartphone,
      shortcut: "M",
      available: props.deviceAvailable,
      disabledReason: SURFACE_UNAVAILABLE_HINTS.device,
      onClick: props.onAddDevice,
    },
    ...(props.onAddSideChat
      ? [
          {
            label: "Side chat",
            description: "Ask a side question while this thread keeps working.",
            icon: MessagesSquare,
            shortcut: "S",
            available: props.sideChatAvailable && !props.sideChatDisabledReason,
            disabledReason: props.sideChatDisabledReason ?? SURFACE_UNAVAILABLE_HINTS.sideChat,
            onClick: props.onAddSideChat,
          },
        ]
      : []),
  ] as const;

  type SurfaceAction = (typeof actions)[number];

  const availableActions = actions.filter((action) => action.available);
  const highlightIndex =
    availableActions.length === 0 ? -1 : Math.min(highlight, availableActions.length - 1);

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const action = surfaceShortcutActionForKey(availableActions, event);
    if (!action) return;
    if (document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
    const target = event.composedPath()[0] ?? event.target;
    if (target instanceof Element && surfaceShortcutTargetsTypingContext(target)) return;
    event.preventDefault();
    event.stopPropagation();
    action.onClick();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a capture-phase window keydown listener for surface shortcuts while the menu is mounted
  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleShortcut(event);
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (availableActions.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      setHighlight((highlightIndex + 1) % availableActions.length);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      setHighlight(
        highlightIndex === -1
          ? availableActions.length - 1
          : (highlightIndex - 1 + availableActions.length) % availableActions.length,
      );
      return;
    }
    if (event.key === "Enter") {
      if (event.target !== event.currentTarget) return;
      const action = availableActions[highlightIndex];
      if (!action) return;
      event.preventDefault();
      action.onClick();
    }
  };

  const isHighlighted = (action: SurfaceAction) =>
    highlightIndex !== -1 && availableActions[highlightIndex] === action;

  const actionIcon = (action: SurfaceAction, iconClassName = "size-4") => {
    const Icon = action.icon;
    return (
      <span className="relative inline-flex shrink-0">
        <Icon className={iconClassName} />
      </span>
    );
  };

  return (
    <div
      data-workspace-focus-default
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Open a surface"
      data-surface-launcher-keys={availableActions.map((action) => action.shortcut).join("")}
      className={cn(
        "scrollbar-gutter-both flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 outline-none",
        "pb-(--workspace-topbar-height)",
      )}
    >
      <div className="w-full max-w-xs py-6">
        <h3 className="mb-3 text-center font-medium text-foreground text-sm">Open a surface</h3>
        <div className="flex flex-col gap-0.5">
          {actions.map((action) =>
            action.available ? (
              <div
                key={action.label}
                className="group relative"
                onMouseEnter={() => setHighlight(availableActions.indexOf(action))}
                onMouseLeave={() =>
                  setHighlight((current) =>
                    current === availableActions.indexOf(action) ? -1 : current,
                  )
                }
              >
                <button
                  type="button"
                  onClick={action.onClick}
                  className={cn(
                    "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm transition-colors group-hover:bg-accent/60",
                    isHighlighted(action) && "bg-accent/60",
                  )}
                >
                  {actionIcon(action, "size-4")}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      action.label === "Browser" && props.browserProfiles.length > 1 && "pr-7",
                    )}
                  >
                    {action.label}
                  </span>
                  <Kbd>{action.shortcut}</Kbd>
                </button>
                {action.label === "Browser" && props.browserProfiles.length > 1 ? (
                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          aria-label="Open browser in a profile"
                          className="absolute top-1/2 right-8 -translate-y-1/2"
                          size="icon-xs"
                          variant="ghost-muted"
                        />
                      }
                    >
                      <ChevronDown className="size-3.5" />
                    </MenuTrigger>
                    <MenuPopup align="end" side="bottom" sideOffset={6} className="max-w-56">
                      {props.browserProfiles.map((profile) => (
                        <MenuItem
                          key={profile.id}
                          onClick={() => props.onAddBrowserInProfile(profile.id)}
                        >
                          <span className="min-w-0 truncate">{profile.name}</span>
                        </MenuItem>
                      ))}
                    </MenuPopup>
                  </Menu>
                ) : null}
              </div>
            ) : (
              <DisabledReasonTooltip
                key={action.label}
                reason={action.disabledReason}
                trigger={
                  <div
                    tabIndex={0}
                    aria-disabled="true"
                    className="flex h-8 w-full cursor-default items-center gap-2.5 rounded-(--control-radius) px-2.5 text-left text-sm opacity-50"
                  >
                    {actionIcon(action, "size-4")}
                    <span className="min-w-0 flex-1 truncate">{action.label}</span>
                    <Kbd>{action.shortcut}</Kbd>
                  </div>
                }
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

function surfaceTitle(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  terminalLabelsById: ReadonlyMap<string, string>,
): string {
  switch (surface.kind) {
    case "diff":
      return "Diff";
    case "files":
      return "Files";
    case "file":
      return surface.relativePath.slice(
        Math.max(surface.relativePath.lastIndexOf("/"), surface.relativePath.lastIndexOf("\\")) + 1,
      );
    case "terminal":
      return (
        terminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId)
      );
    case "pull-request":
      return `#${surface.number}`;
    case "pull-requests":
      return "Pull requests";
    case "device":
      return surface.title ?? surface.target?.name ?? "Device";
    case "side-chat":
      return "Side chat";
    case "preview": {
      const snapshot = surface.resourceId ? sessions[surface.resourceId] : null;
      if (!snapshot || snapshot.navStatus._tag === "Idle") return "Browser";
      if (snapshot.navStatus.title.trim().length > 0) return snapshot.navStatus.title;
      try {
        return new URL(snapshot.navStatus.url).host || "Browser";
      } catch {
        return "Browser";
      }
    }
  }
}

function PreviewFavicon({ capturedUrl, url }: { capturedUrl: string | null; url: string | null }) {
  const publicProviderUrl = faviconUrlForOrigin(url, 32);
  return (
    <FaviconImage
      sources={[capturedUrl, publicProviderUrl]}
      fallback={<Globe2 className="size-3 shrink-0" />}
      className="size-3 shrink-0 rounded-sm object-contain"
    />
  );
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function previewFaviconOf(
  surface: RightPanelSurface,
  sessions: Readonly<Record<string, PreviewSessionSnapshot>>,
  desktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>,
): { url: string | null; capturedUrl: string | null } {
  const snapshot =
    surface.kind === "preview" && surface.resourceId ? sessions[surface.resourceId] : null;
  const url = !snapshot || snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
  const favicon = snapshot ? (desktopByTabId[snapshot.tabId]?.favicon ?? null) : null;
  const capturedUrl = favicon && url && sameOrigin(favicon.pageUrl, url) ? favicon.dataUrl : null;
  return { url, capturedUrl };
}

function SurfaceIcon({
  surface,
  previewUrl,
  previewCapturedUrl,
  theme,
  environmentId,
  pullRequestStatusSeed,
}: {
  surface: RightPanelSurface;
  previewUrl: string | null;
  previewCapturedUrl: string | null;
  theme: "light" | "dark";
  environmentId: EnvironmentId | null;
  pullRequestStatusSeed: PullRequestTabStatusSeed | undefined;
}) {
  switch (surface.kind) {
    case "preview":
      return <PreviewFavicon capturedUrl={previewCapturedUrl} url={previewUrl} />;
    case "diff":
      return <FileDiff className="size-3 shrink-0" />;
    case "files":
      return <Files className="size-3 shrink-0" />;
    case "file":
      return (
        <PierreEntryIcon
          pathValue={surface.relativePath}
          kind="file"
          theme={theme}
          className="size-3"
        />
      );
    case "terminal":
      return <TerminalSquare className="size-3 shrink-0" />;
    case "pull-request":
      return (
        <PullRequestSurfaceIcon
          surface={surface}
          environmentId={environmentId}
          seed={pullRequestStatusSeed}
        />
      );
    case "pull-requests":
      return <PullRequestGlyph.link className="size-3 shrink-0" />;
    case "side-chat":
      return <SideChatTabIcon environmentId={environmentId} threadId={surface.threadId} />;
    case "device":
      return surface.target?.platform === "ios" ? (
        <AppleIcon className="size-3 shrink-0" />
      ) : surface.target?.platform === "android" ? (
        <AndroidIcon className="size-3 shrink-0" />
      ) : (
        <Smartphone className="size-3 shrink-0" />
      );
  }
}

/** What a side chat tab's dot shows and its title's accessible name says. */
function sideChatTabState(shell: EnvironmentThreadShell | null) {
  if (shell === null) return null;
  if (shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval") {
    return "needs approval";
  }
  if (shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input") {
    return "needs input";
  }
  return threadRuntimeIsActive(shell.runtime) ? "running" : null;
}

// Static dots: a side chat tab can stay open for a whole run.
function SideChatTabIcon(props: { environmentId: EnvironmentId | null; threadId: ThreadId }) {
  const state = sideChatTabState(
    useQuietThreadShell(
      props.environmentId === null ? null : scopeThreadRef(props.environmentId, props.threadId),
    ),
  );
  return (
    <>
      <MessagesSquare className="size-3 shrink-0" />
      {state === null ? null : (
        <span
          className={cn(
            "absolute -top-0.5 -right-0.5 size-1.5 rounded-full",
            state === "running" ? "bg-muted-foreground" : "bg-info",
          )}
          aria-hidden
        />
      )}
    </>
  );
}

export function resolvePullRequestTabLink(
  threads: readonly Pick<EnvironmentThreadShell, "environmentId" | "pullRequests">[],
  environmentId: EnvironmentId | null,
  host: string | null,
  reference: { repository: string; number: number },
) {
  if (environmentId === null || host === null) return undefined;
  let newest: EnvironmentThreadShell["pullRequests"][number] | undefined;
  for (const thread of threads) {
    if (thread.environmentId !== environmentId) continue;
    for (const link of visibleThreadPullRequests(thread.pullRequests)) {
      if (
        !threadPullRequestKeysEqual(link, {
          host,
          repository: reference.repository,
          number: reference.number,
        })
      )
        continue;
      if (
        newest === undefined ||
        (link.snapshot?.syncedAt ?? "") > (newest.snapshot?.syncedAt ?? "")
      )
        newest = link;
    }
  }
  return newest;
}

function PullRequestSurfaceIcon({
  surface,
  environmentId,
  seed,
}: {
  surface: Extract<RightPanelSurface, { kind: "pull-request" }>;
  environmentId: EnvironmentId | null;
  seed: PullRequestTabStatusSeed | undefined;
}) {
  const resolvedEnvironmentId =
    (surface.environmentId as EnvironmentId | undefined) ?? environmentId;
  const projects = useProjects();
  const threads = useThreadShells();
  const project = projects.find(
    (entry) => entry.environmentId === resolvedEnvironmentId && entry.id === surface.projectId,
  );
  const identity = project?.repositoryIdentity;
  const host =
    surface.host ??
    (identity?.provider
      ? sourceControlClients.changeRequestHost(identity, identity.provider)
      : null);
  const configs = useServerConfigs();
  const capabilities =
    resolvedEnvironmentId === null
      ? undefined
      : configs.get(resolvedEnvironmentId)?.environment.capabilities;
  const linkedSnapshot =
    capabilities !== undefined
      ? (resolvePullRequestTabLink(threads, resolvedEnvironmentId, host, surface)?.snapshot ?? null)
      : null;
  const detail = useEnvironmentQuery(
    resolvedEnvironmentId === null || capabilities === undefined || linkedSnapshot !== null
      ? null
      : pullRequestEnvironment.detail({
          environmentId: resolvedEnvironmentId,
          input: {
            projectId: surface.projectId as ProjectId,
            ...(capabilities !== undefined && surface.host !== undefined
              ? { host: surface.host }
              : {}),
            repository: surface.repository,
            number: surface.number,
            allowStale: false,
          },
        }),
  ).data;
  const reference = {
    projectId: surface.projectId as ProjectId,
    repository: surface.repository,
    number: surface.number,
  };
  const sharedSummary = useSharedPullRequestSummary(resolvedEnvironmentId, reference);
  const status = linkedSnapshot ?? newestPullRequestSummary(detail, sharedSummary) ?? seed ?? null;
  if (status === null) {
    return <PullRequestGlyph.pullRequest className="size-3 shrink-0 text-muted-foreground" />;
  }
  const presentation = resolvePullRequestState({
    state: status.state,
    isDraft: status.isDraft ?? detail?.isDraft ?? seed?.isDraft ?? false,
  });
  return <presentation.Icon className={cn("size-3 shrink-0", presentation.toneClassName)} />;
}

function SortableTabList(props: {
  surfaces: readonly RightPanelSurface[];
  onMove: ((surfaceId: string, toIndex: number) => void) | undefined;
  children: ReactNode;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const surfaceIds = props.surfaces.map((surface) => surface.id);
  const { onMove, surfaces } = props;
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const toIndex = surfaces.findIndex((surface) => surface.id === over.id);
    if (toIndex >= 0) onMove?.(String(active.id), toIndex);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={TAB_DRAG_MODIFIERS}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={surfaceIds} strategy={horizontalListSortingStrategy}>
        {props.children}
      </SortableContext>
    </DndContext>
  );
}

interface RightPanelTabHandlers {
  onActivate: (surface: RightPanelSurface) => void;
  onClose: (surface: RightPanelSurface) => void;
  onAuxClick: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onContextMenu: (event: ReactMouseEvent, surface: RightPanelSurface) => void;
  onStartRename: (surfaceId: string) => void;
  onFinishRename: (surfaceId: string, title: string) => void;
}

// Chromium on Linux only suppresses primary-selection paste when mouseup is cancelled.
function preventTabMiddleButtonDefault(event: ReactMouseEvent) {
  if (event.button !== 1) return;
  event.preventDefault();
}

// Stable handlers and per-tab values let the compiler reuse tabs across parent renders.
function RightPanelTab(
  props: RightPanelTabHandlers & {
    surface: RightPanelSurface;
    dragDisabled: boolean;
    active: boolean;
    pending: boolean;
    title: string;
    audio: TabAudioState;
    audioRuntimeTabId: string | null;
    previewUrl: string | null;
    previewCapturedUrl: string | null;
    theme: "light" | "dark";
    environmentId: EnvironmentId | null;
    pullRequestStatusSeed: PullRequestTabStatusSeed | undefined;
    renaming: boolean;
    canRename: boolean;
    ownsDesktopTitleBar: boolean;
  },
) {
  const {
    surface,
    audio,
    audioRuntimeTabId,
    onActivate,
    onClose,
    onAuxClick,
    onContextMenu,
    onStartRename,
    onFinishRename,
  } = props;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.id,
    disabled: props.dragDisabled,
  });
  const sideChatShell = useQuietThreadShell(
    surface.kind === "side-chat" && props.environmentId !== null
      ? scopeThreadRef(props.environmentId, surface.threadId)
      : null,
  );
  const title = sideChatShell?.title ?? props.title;
  const sideChatState = sideChatTabState(sideChatShell);
  const content = (
    <>
      <PanelTabCloseButton label={`Close ${title}`} onClick={() => onClose(surface)}>
        <SurfaceIcon
          surface={surface}
          previewUrl={props.previewUrl}
          previewCapturedUrl={props.previewCapturedUrl}
          theme={props.theme}
          environmentId={props.environmentId}
          pullRequestStatusSeed={props.pullRequestStatusSeed}
        />
        {props.pending ? (
          <span
            className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full bg-current"
            aria-hidden
          />
        ) : null}
      </PanelTabCloseButton>
      {audio === "none" || !audioRuntimeTabId ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="cursor-pointer flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
                aria-label={audio === "muted" ? `Unmute ${title}` : `Mute ${title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void previewBridge
                    ?.setAudioMuted(audioRuntimeTabId, audio !== "muted")
                    .catch(() => undefined);
                }}
              >
                {audio === "muted" ? (
                  <VolumeOffIcon className="size-3" />
                ) : (
                  <Volume2Icon className="size-3" />
                )}
              </button>
            }
          />
          <TooltipPopup>{audio === "muted" ? "Unmute tab" : "Mute tab"}</TooltipPopup>
        </Tooltip>
      )}
      {props.renaming ? (
        <input
          aria-label="Device tab name"
          className="w-24 min-w-0 rounded-sm bg-background px-1 outline-none ring-1 ring-inset ring-ring"
          defaultValue={title}
          ref={(element) => {
            element?.focus();
            element?.select();
          }}
          onBlur={(event) => onFinishRename(surface.id, event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = title;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onDoubleClick={() => {
                  if (surface.kind === "device" && props.canRename) onStartRename(surface.id);
                }}
                className="cursor-pointer flex min-w-0 items-center"
                aria-label={sideChatState === null ? undefined : `${title}, ${sideChatState}`}
                onClick={() => onActivate(surface)}
              >
                <span className="truncate">{title}</span>
              </button>
            }
          />
          <TooltipPopup>
            {surface.kind === "device" ? (
              <DeviceTabTooltip
                surface={surface}
                environmentId={props.environmentId}
                title={title}
              />
            ) : (
              title
            )}
          </TooltipPopup>
        </Tooltip>
      )}
    </>
  );
  return (
    <div
      data-active-tab={props.active}
      onMouseDown={preventTabMiddleButtonDefault}
      onMouseUp={preventTabMiddleButtonDefault}
      onAuxClick={(event) => onAuxClick(event, surface)}
      onContextMenu={(event) => onContextMenu(event, surface)}
      {...listeners}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
        props.ownsDesktopTitleBar && "[-webkit-app-region:no-drag]",
        props.active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
        isDragging && "relative z-10",
      )}
    >
      {content}
    </div>
  );
}

export function RightPanelTabs(props: RightPanelTabsProps) {
  const focusedSurface = props.surfaces.find((surface) => surface.id === props.activeSurfaceId);
  const ownsDesktopTitleBar =
    isElectron && props.mode === "inline" && (props.pane === undefined || props.pane.topRight);
  const answersShortcuts = props.open !== false && props.pane?.focused !== false;
  const browserProfiles = useBrowserDefaults().profiles;
  const { resolvedTheme } = useTheme();
  const tabListRef = useRef<HTMLDivElement>(null);
  const addSurfaceTriggerRef = useRef<HTMLButtonElement>(null);
  const addSurfacePressRef = useRef<{
    holdTimer: ReturnType<typeof setTimeout> | null;
    handled: boolean;
  }>({ holdTimer: null, handled: false });
  const [renamingDevice, setRenamingDevice] = useState<string | null>(null);
  const [addSurfaceMenuOpen, setAddSurfaceMenuOpen] = useState(false);
  const [tabScrollState, setTabScrollState] = useState({
    hasOverflow: false,
    canScrollLeft: false,
    canScrollRight: false,
  });

  if (props.open === false && addSurfaceMenuOpen) setAddSurfaceMenuOpen(false);

  const onNewSurfaceKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (
      resolveShortcutCommand(event, props.keybindings, {
        context: { ...props.getShortcutContext(), rightPanelOpen: true },
      }) !== "rightPanel.new"
    )
      return;
    if (!addSurfaceMenuOpen && document.querySelector(LAUNCHER_SHORTCUT_BLOCKING_LAYERS)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) {
      addSurfaceTriggerRef.current?.focus();
      setAddSurfaceMenuOpen(true);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for the new surface shortcut while the panel is open
  useEffect(() => {
    if (!answersShortcuts) return;
    document.addEventListener("keydown", onNewSurfaceKeyDown, true);
    return () => document.removeEventListener("keydown", onNewSurfaceKeyDown, true);
  }, [answersShortcuts]);

  const updateTabScrollState = (viewport: HTMLDivElement) => {
    const hasOverflow = viewport.scrollWidth - viewport.clientWidth > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollLeft = hasOverflow && viewport.scrollLeft > TAB_SCROLL_EDGE_TOLERANCE;
    const canScrollRight =
      hasOverflow &&
      viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - TAB_SCROLL_EDGE_TOLERANCE;
    setTabScrollState((current) => {
      if (
        current.hasOverflow === hasOverflow &&
        current.canScrollLeft === canScrollLeft &&
        current.canScrollRight === canScrollRight
      ) {
        return current;
      }
      return { hasOverflow, canScrollLeft, canScrollRight };
    });
  };

  const scrollTabs = (direction: -1 | 1) => {
    const viewport = tabScrollViewport(tabListRef.current);
    if (!viewport) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollBy({
      left: direction * Math.max(120, viewport.clientWidth * 0.75),
      behavior: reduceMotion ? "auto" : "smooth",
    });
  };

  const addSurfaceActions = [
    {
      label: "Browser",
      icon: Globe2,
      shortcut: "B",
      available: props.browserAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.browser,
      onClick: props.onAddBrowser,
    },
    {
      label: "Terminal",
      icon: TerminalSquare,
      shortcut: "T",
      available: props.terminalAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.terminal,
      onClick: props.onAddTerminal,
    },
    {
      label: "Files",
      icon: Files,
      shortcut: "F",
      available: props.filesAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.files,
      onClick: props.onAddFiles,
    },
    {
      label: "Diff",
      icon: FileDiff,
      shortcut: "D",
      available: props.diffAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.diff,
      onClick: props.onAddDiff,
    },
    {
      label: "Pull request",
      icon: PullRequestGlyph.pullRequest,
      shortcut: "P",
      available: props.pullRequestAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.pullRequest,
      onClick: props.onAddPullRequest,
    },
    {
      label: "Linked pull requests",
      icon: PullRequestGlyph.link,
      shortcut: "L",
      available: props.pullRequestsAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.pullRequests,
      onClick: props.onAddPullRequests,
    },
    {
      label: "Device",
      icon: Smartphone,
      shortcut: "M",
      available: props.deviceAvailable,
      disabledReason: SURFACE_DISABLED_REASONS.device,
      onClick: props.onAddDevice,
    },
    ...(props.onAddSideChat
      ? [
          {
            label: "Side chat",
            icon: MessagesSquare,
            shortcut: "S",
            available: props.sideChatAvailable === true && !props.sideChatDisabledReason,
            disabledReason: props.sideChatDisabledReason ?? SURFACE_DISABLED_REASONS.sideChat,
            onClick: props.onAddSideChat,
          },
        ]
      : []),
  ] as const;

  // Beside a browser, terminal or files tab, "+" opens another of the same; holding it lists every surface.
  const defaultAddAction =
    addSurfaceActions.find(
      (action) =>
        action.available &&
        action.label ===
          (focusedSurface?.kind === "preview"
            ? "Browser"
            : focusedSurface?.kind === "terminal"
              ? "Terminal"
              : focusedSurface?.kind === "files" || focusedSurface?.kind === "file"
                ? "Files"
                : null),
    ) ?? null;
  const clearAddSurfaceHold = () => {
    const press = addSurfacePressRef.current;
    if (press.holdTimer !== null) clearTimeout(press.holdTimer);
    press.holdTimer = null;
  };
  const handleAddSurfacePointerDown = (event: ReactPointerEvent) => {
    if (!defaultAddAction || event.button !== 0) return;
    const press = addSurfacePressRef.current;
    // A press on the open menu's trigger only closes it.
    press.handled = addSurfaceMenuOpen;
    if (addSurfaceMenuOpen) return;
    press.holdTimer = setTimeout(() => {
      press.holdTimer = null;
      press.handled = true;
      setAddSurfaceMenuOpen(true);
    }, ADD_SURFACE_HOLD_MS);
  };
  const handleAddSurfacePointerAway = () => {
    clearAddSurfaceHold();
    addSurfacePressRef.current.handled = false;
  };
  const handleAddSurfaceClick = () => {
    if (!defaultAddAction) return;
    clearAddSurfaceHold();
    const press = addSurfacePressRef.current;
    if (press.handled) {
      press.handled = false;
      return;
    }
    defaultAddAction.onClick();
  };

  const handleAddSurfaceMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = surfaceShortcutActionForKey(addSurfaceActions, event.nativeEvent);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    setAddSurfaceMenuOpen(false);
    action.onClick();
  };

  const handleTabContextMenu = async (event: ReactMouseEvent, surface: RightPanelSurface) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readLocalApi();
    if (!api) return;

    const surfaceIndex = props.surfaces.findIndex((entry) => entry.id === surface.id);
    if (surfaceIndex < 0) return;

    const items: ContextMenuItem<TabContextMenuAction>[] = [];
    if (surface.kind === "device" && props.onRenameDevice)
      items.push({ id: "rename", label: "Rename" });
    if (surface.kind === "file" && surface.attachment === undefined) {
      items.push({ id: "copy-path", label: "Copy path" });
    }
    const menuPreviewTabId = previewTabIdOf(surface, props.previewSessions);
    const menuOverlay = menuPreviewTabId ? (props.desktopByTabId[menuPreviewTabId] ?? null) : null;
    const menuMuted = menuOverlay?.audioMuted ?? false;
    if (surface.kind === "preview") {
      items.push({
        id: "toggle-mute",
        ...tabMuteMenuItem({
          overlay: menuOverlay,
          canResolveRuntimeTabId: props.previewRuntimeTabId !== undefined,
        }),
      });
    }
    items.push(
      { id: "close", label: "Close" },
      {
        id: "close-others",
        label: "Close others",
        disabled: props.surfaces.length <= 1,
      },
      {
        id: "close-to-right",
        label: "Close to the right",
        disabled: surfaceIndex >= props.surfaces.length - 1,
      },
      {
        id: "close-all",
        label: "Close all",
        disabled: props.surfaces.length === 0,
      },
    );

    const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
    switch (action) {
      case "rename":
        setRenamingDevice(surface.id);
        break;
      case "copy-path":
        if (surface.kind === "file" && surface.attachment === undefined) {
          props.onCopyFilePath(surface.relativePath);
        }
        break;
      case "toggle-mute": {
        const runtimeTabId =
          menuPreviewTabId && menuOverlay
            ? (props.previewRuntimeTabId?.(menuPreviewTabId) ?? null)
            : null;
        if (runtimeTabId) {
          void previewBridge?.setAudioMuted(runtimeTabId, !menuMuted).catch(() => undefined);
        }
        break;
      }
      case "close":
        props.onCloseSurface(surface);
        break;
      case "close-others":
        props.onCloseOtherSurfaces(surface);
        break;
      case "close-to-right":
        props.onCloseSurfacesToRight(surface);
        break;
      case "close-all":
        props.onCloseAllSurfaces();
        break;
      case null:
        break;
    }
  };
  const handleTabAuxClick = (event: ReactMouseEvent, surface: RightPanelSurface) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    props.onCloseSurface(surface);
  };
  const onActivateTab = useStableCallback(props.onActivate);
  const onCloseTab = useStableCallback(props.onCloseSurface);
  const onTabAuxClick = useStableCallback(handleTabAuxClick);
  const onTabContextMenu = useStableCallback(
    (event: ReactMouseEvent, surface: RightPanelSurface) => {
      void handleTabContextMenu(event, surface);
    },
  );
  const onStartRenameTab = useStableCallback((surfaceId: string) => setRenamingDevice(surfaceId));
  const onFinishRenameTab = useStableCallback((surfaceId: string, title: string) => {
    props.onRenameDevice?.(surfaceId, title);
    setRenamingDevice(null);
  });

  // A newly active tab, or tabs that start overflowing, can sit outside the scrolled strip.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the active tab DOM node into view after it changes or the tab strip starts overflowing
  useEffect(() => {
    if (!props.activeSurfaceId || !tabScrollState.hasOverflow) return;
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.activeSurfaceId, tabScrollState.hasOverflow]);

  const attachTabList = (root: HTMLDivElement | null) => {
    tabListRef.current = root;
    const viewport = tabScrollViewport(root);
    if (!viewport) return;

    const update = () => updateTabScrollState(viewport);
    // Only a vertical mouse wheel is translated. Horizontal input scrolls natively, since
    // consuming it keeps Chromium from starting the gesture scroll that swipe navigation tracks.
    const handleWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      let delta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= viewport.clientWidth;

      const previousScrollLeft = viewport.scrollLeft;
      viewport.scrollLeft += delta;
      if (viewport.scrollLeft === previousScrollLeft) return;
      event.preventDefault();
      update();
    };

    const content = viewport.firstElementChild;
    const stopObserving = observeResize(content ? [viewport, content] : viewport, update);
    viewport.addEventListener("scroll", update, { passive: true });
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    update();

    return () => {
      tabListRef.current = null;
      stopObserving();
      viewport.removeEventListener("scroll", update);
      viewport.removeEventListener("wheel", handleWheel);
    };
  };

  const body = (
    <>
      <div
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2",
          props.mode === "inline" && !props.layoutControls && !props.pane ? "pr-28" : "pr-3",
          ownsDesktopTitleBar && "drag-region",
          ownsDesktopTitleBar && "wco:pr-(--workspace-native-controls-inset)",
          props.mode === "inline" &&
            props.maximized &&
            (props.pane === undefined || props.pane.topLeft) &&
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
        data-right-panel-tabbar
      >
        <ScrollArea
          radius="none"
          ref={attachTabList}
          hideScrollbars
          scrollFade
          className="min-w-0 flex-1"
          data-right-panel-tab-list
        >
          <div className="flex h-full w-max min-w-full items-center gap-1">
            <SortableTabList surfaces={props.surfaces} onMove={props.onMoveSurface}>
              {props.surfaces.map((surface) => {
                const previewTabId = previewTabIdOf(surface, props.previewSessions);
                const favicon = previewFaviconOf(
                  surface,
                  props.previewSessions,
                  props.desktopByTabId,
                );
                return (
                  <RightPanelTab
                    key={surface.id}
                    surface={surface}
                    dragDisabled={!props.onMoveSurface || renamingDevice === surface.id}
                    active={surface.id === props.activeSurfaceId}
                    pending={props.pendingSurfaceIds.has(surface.id)}
                    title={surfaceTitle(surface, props.previewSessions, props.terminalLabelsById)}
                    audio={tabAudioState(
                      previewTabId ? (props.desktopByTabId[previewTabId] ?? null) : null,
                    )}
                    audioRuntimeTabId={
                      previewTabId ? (props.previewRuntimeTabId?.(previewTabId) ?? null) : null
                    }
                    previewUrl={favicon.url}
                    previewCapturedUrl={favicon.capturedUrl}
                    theme={resolvedTheme}
                    environmentId={props.environmentId}
                    pullRequestStatusSeed={props.pullRequestStatusSeeds?.[surface.id]}
                    renaming={renamingDevice === surface.id}
                    canRename={props.onRenameDevice !== undefined}
                    ownsDesktopTitleBar={ownsDesktopTitleBar}
                    onActivate={onActivateTab}
                    onClose={onCloseTab}
                    onAuxClick={onTabAuxClick}
                    onContextMenu={onTabContextMenu}
                    onStartRename={onStartRenameTab}
                    onFinishRename={onFinishRenameTab}
                  />
                );
              })}
            </SortableTabList>
            {props.open !== false ? (
              <Menu
                open={addSurfaceMenuOpen}
                onOpenChange={(open, details) => {
                  // The trigger's own press is a click or a hold here, read by the handlers below.
                  if (open && defaultAddAction && details.reason === "trigger-press") return;
                  setAddSurfaceMenuOpen(open);
                }}
              >
                <MenuTrigger
                  ref={addSurfaceTriggerRef}
                  render={
                    <Button
                      aria-label="Add panel surface"
                      className="shrink-0"
                      size="icon-xs"
                      title={
                        defaultAddAction
                          ? `New ${defaultAddAction.label.toLowerCase()} tab. Hold for all surfaces.`
                          : undefined
                      }
                      variant="ghost-muted"
                      onClick={handleAddSurfaceClick}
                      onContextMenu={(event) => {
                        if (!defaultAddAction) return;
                        event.preventDefault();
                        setAddSurfaceMenuOpen(true);
                      }}
                      onPointerCancel={handleAddSurfacePointerAway}
                      onPointerDown={handleAddSurfacePointerDown}
                      onPointerLeave={handleAddSurfacePointerAway}
                    />
                  }
                >
                  <Plus className="size-3.5" />
                </MenuTrigger>
                <MenuPopup
                  align="start"
                  side="bottom"
                  sideOffset={6}
                  onKeyDownCapture={handleAddSurfaceMenuKeyDown}
                >
                  {addSurfaceActions.map((action) => {
                    const Icon = action.icon;
                    if (action.label === "Browser" && action.available) {
                      return (
                        <MenuSub key={action.label}>
                          <MenuSubTrigger
                            className="[&>svg:last-child]:ms-0"
                            aria-keyshortcuts={action.shortcut}
                            onClick={(event) => {
                              const pointerType =
                                "pointerType" in event.nativeEvent &&
                                typeof event.nativeEvent.pointerType === "string"
                                  ? event.nativeEvent.pointerType
                                  : undefined;
                              if (!shouldOpenDefaultBrowserProfileFromMenuClick(pointerType))
                                return;
                              setAddSurfaceMenuOpen(false);
                              action.onClick();
                            }}
                          >
                            <Icon />
                            {action.label}
                            <MenuShortcut>{action.shortcut}</MenuShortcut>
                          </MenuSubTrigger>
                          <MenuSubPopup className="max-w-56">
                            {browserProfiles.map((profile) => (
                              <MenuItem
                                key={profile.id}
                                onClick={() => props.onAddBrowserInProfile(profile.id)}
                              >
                                <span className="min-w-0 truncate">{profile.name}</span>
                              </MenuItem>
                            ))}
                          </MenuSubPopup>
                        </MenuSub>
                      );
                    }
                    return (
                      <SurfaceMenuItem
                        key={action.label}
                        available={action.available}
                        disabledReason={action.disabledReason}
                        shortcut={action.shortcut}
                        onClick={action.onClick}
                      >
                        <Icon />
                        {action.label}
                      </SurfaceMenuItem>
                    );
                  })}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        </ScrollArea>
        {tabScrollState.hasOverflow ? (
          <div
            className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]"
            role="group"
            aria-label="Scroll panel tabs"
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label="Scroll tabs left"
                      disabled={!tabScrollState.canScrollLeft}
                      onClick={() => scrollTabs(-1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronLeft />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>Scroll tabs left</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex">
                    <Button
                      aria-label="Scroll tabs right"
                      disabled={!tabScrollState.canScrollRight}
                      onClick={() => scrollTabs(1)}
                      size="icon-xs"
                      variant="ghost"
                    >
                      <ChevronRight />
                    </Button>
                  </span>
                }
              />
              <TooltipPopup>Scroll tabs right</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
        {props.pane?.controls}
        {props.layoutControls}
        {ownsDesktopTitleBar && !props.layoutControls ? (
          <span aria-hidden className="hidden w-24 shrink-0 wco:block" />
        ) : null}
        {ownsDesktopTitleBar ? (
          <span
            aria-hidden
            className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
          />
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-surface-content>
        {props.activeSurfaceId === null ? (
          <RightPanelEmptyState
            onAddBrowser={props.onAddBrowser}
            onAddBrowserInProfile={props.onAddBrowserInProfile}
            browserProfiles={browserProfiles}
            onAddTerminal={props.onAddTerminal}
            onAddDiff={props.onAddDiff}
            onAddFiles={props.onAddFiles}
            onAddPullRequest={props.onAddPullRequest}
            onAddPullRequests={props.onAddPullRequests}
            onAddDevice={props.onAddDevice}
            onAddSideChat={props.onAddSideChat}
            browserAvailable={props.browserAvailable}
            terminalAvailable={props.terminalAvailable}
            diffAvailable={props.diffAvailable}
            filesAvailable={props.filesAvailable}
            pullRequestAvailable={props.pullRequestAvailable}
            pullRequestsAvailable={props.pullRequestsAvailable}
            deviceAvailable={props.deviceAvailable}
            sideChatAvailable={props.sideChatAvailable === true}
            sideChatDisabledReason={props.sideChatDisabledReason ?? null}
          />
        ) : (
          props.children
        )}
      </div>
    </>
  );
  if (props.pane) {
    return (
      <div
        className={cn("flex min-h-0 min-w-0 flex-col", props.pane.className)}
        style={props.pane.style}
        data-right-panel-pane
        onPointerDownCapture={props.pane.onFocus}
      >
        {body}
      </div>
    );
  }
  return (
    <PreviewPanelShell
      workspaceArea
      workspaceFocusKey={`panel:${props.environmentId}:${props.activeSurfaceId ?? "empty"}`}
      workspaceLabel={
        focusedSurface
          ? `Workspace panel: ${surfaceTitle(focusedSurface, props.previewSessions, props.terminalLabelsById)}`
          : "Workspace panel"
      }
      mode={props.mode}
      {...(props.maximized !== undefined ? { maximized: props.maximized } : {})}
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.widthStorageKey !== undefined ? { widthStorageKey: props.widthStorageKey } : {})}
      {...(props.defaultWidth !== undefined ? { defaultWidth: props.defaultWidth } : {})}
      {...(props.inlineSize ? { inlineSize: props.inlineSize } : {})}
      onMouseDown={preventThumbButtonFocus}
      onMouseUp={(event) =>
        takeThumbButtonNavigation(
          event,
          focusedSurface?.kind === "preview" ? dispatchPreviewAction : undefined,
        )
      }
    >
      {body}
    </PreviewPanelShell>
  );
}

const PANE_MOVES = [
  { move: "left", label: "Move left", icon: ArrowLeft },
  { move: "right", label: "Move right", icon: ArrowRight },
  { move: "up", label: "Move up", icon: ArrowUp },
  { move: "down", label: "Move down", icon: ArrowDown },
] as const satisfies ReadonlyArray<{ move: RightPanelPaneMove; label: string; icon: unknown }>;

function RightPanelPaneMenu(props: {
  layout: ReadonlyArray<ReadonlyArray<RightPanelPaneKind>>;
  kind: RightPanelPaneKind;
  onMove: (kind: RightPanelPaneKind, move: RightPanelPaneMove) => void;
  onHide: (kind: RightPanelPaneKind) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label="Pane options"
            className="shrink-0 [-webkit-app-region:no-drag]"
            size="icon-xs"
            variant="ghost-muted"
          />
        }
      >
        <EllipsisVertical className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" sideOffset={6}>
        {PANE_MOVES.map(({ move, label, icon: Icon }) => (
          <MenuItem
            key={move}
            disabled={movedRightPanelPaneLayout(props.layout, props.kind, move) === null}
            onClick={() => props.onMove(props.kind, move)}
          >
            <Icon />
            {label}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={() => props.onHide(props.kind)}>
          <EyeOff />
          Hide pane
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

const PANE_MIN_PX = { x: 220, y: 140 } as const;

/** A drag line between two panes or columns; they trade flex share and their total stays put. */
function RightPanelPaneDivider(props: {
  axis: "x" | "y";
  onResize: (before: number, after: number) => void;
}) {
  const dragRef = useRef<{
    pointerId: number;
    start: number;
    before: HTMLElement;
    after: HTMLElement;
    beforePx: number;
    totalPx: number;
    totalShare: number;
    shares: readonly [number, number] | null;
  } | null>(null);
  const shareOf = (element: HTMLElement) => Number.parseFloat(element.style.flexGrow) || 1;
  const neighbours = (handle: HTMLElement) => {
    const before = handle.previousElementSibling;
    const after = handle.nextElementSibling;
    return before instanceof HTMLElement && after instanceof HTMLElement ? { before, after } : null;
  };
  const finish = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.shares) props.onResize(...drag.shares);
  };
  return (
    <div
      role="separator"
      aria-label="Resize panes"
      aria-orientation={props.axis === "x" ? "vertical" : "horizontal"}
      className={cn(
        "group relative z-20 shrink-0 touch-none select-none",
        props.axis === "x" ? "w-0 cursor-col-resize" : "h-0 cursor-row-resize",
      )}
      onDoubleClick={(event) => {
        const pair = neighbours(event.currentTarget);
        if (!pair) return;
        const share = (shareOf(pair.before) + shareOf(pair.after)) / 2;
        props.onResize(share, share);
      }}
      onPointerDown={(event) => {
        const pair = event.button === 0 ? neighbours(event.currentTarget) : null;
        if (!pair) return;
        const size = (element: HTMLElement) =>
          props.axis === "x"
            ? element.getBoundingClientRect().width
            : element.getBoundingClientRect().height;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
        dragRef.current = {
          pointerId: event.pointerId,
          start: props.axis === "x" ? event.clientX : event.clientY,
          ...pair,
          beforePx: size(pair.before),
          totalPx: size(pair.before) + size(pair.after),
          totalShare: shareOf(pair.before) + shareOf(pair.after),
          shares: null,
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const delta = (props.axis === "x" ? event.clientX : event.clientY) - drag.start;
        const min = Math.min(PANE_MIN_PX[props.axis], drag.totalPx / 2);
        const beforePx = Math.max(min, Math.min(drag.totalPx - min, drag.beforePx + delta));
        const before = Math.round(((drag.totalShare * beforePx) / drag.totalPx) * 1000) / 1000;
        const after = Math.round((drag.totalShare - before) * 1000) / 1000;
        // Written straight to the DOM so a drag never re-renders the panes; release commits it.
        drag.before.style.flexGrow = String(before);
        drag.after.style.flexGrow = String(after);
        drag.shares = [before, after];
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      <span
        aria-hidden
        className={cn(
          "absolute",
          props.axis === "x" ? "inset-y-0 -left-1 w-2" : "inset-x-0 -top-1 h-2",
        )}
      />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute bg-transparent transition-colors duration-150 group-hover:bg-primary/60 group-active:bg-primary/60",
          props.axis === "x" ? "inset-y-0 left-0 w-px" : "inset-x-0 top-0 h-px",
        )}
      />
    </div>
  );
}

export interface RightPanelPanesProps extends Omit<RightPanelTabsProps, "pane"> {
  /** Columns of showing panes. With none, the plain tab strip and `children` draw instead. */
  panes: ReadonlyArray<ReadonlyArray<RightPanelPane>>;
  paneSizes: RightPanelPaneSizes | undefined;
  /** Drawn at the panel's top-right corner, after the last tab strip there. */
  cornerControls: ReactNode;
  onResizePanes: (sizes: RightPanelPaneSizes) => void;
  renderPane: (surface: RightPanelSurface) => ReactNode;
  onMovePane: (kind: RightPanelPaneKind, move: RightPanelPaneMove) => void;
  onHidePane: (kind: RightPanelPaneKind) => void;
}

/** Every showing pane at once: columns side by side, panes stacked within a column. */
export function RightPanelPanes(props: RightPanelPanesProps) {
  const {
    panes,
    paneSizes,
    cornerControls,
    renderPane,
    onMovePane,
    onHidePane,
    onResizePanes,
    children,
    ...tabs
  } = props;
  if (panes.length === 0) {
    return (
      <RightPanelTabs {...tabs} layoutControls={cornerControls}>
        {children}
      </RightPanelTabs>
    );
  }

  const focusedSurface = tabs.surfaces.find((surface) => surface.id === tabs.activeSurfaceId);
  const layout = panes.map((column) => column.map((pane) => pane.kind));
  const moveSurface = tabs.onMoveSurface;
  return (
    <PreviewPanelShell
      workspaceArea
      workspaceFocusKey={`panel:${tabs.environmentId}:${tabs.activeSurfaceId ?? "empty"}`}
      workspaceLabel={
        focusedSurface
          ? `Workspace panel: ${surfaceTitle(focusedSurface, tabs.previewSessions, tabs.terminalLabelsById)}`
          : "Workspace panel"
      }
      mode={tabs.mode}
      {...(tabs.maximized !== undefined ? { maximized: tabs.maximized } : {})}
      {...(tabs.open !== undefined ? { open: tabs.open } : {})}
      {...(tabs.widthStorageKey !== undefined ? { widthStorageKey: tabs.widthStorageKey } : {})}
      {...(tabs.defaultWidth !== undefined ? { defaultWidth: tabs.defaultWidth } : {})}
      {...(tabs.inlineSize ? { inlineSize: tabs.inlineSize } : {})}
      onMouseDown={preventThumbButtonFocus}
      onMouseUp={(event) =>
        takeThumbButtonNavigation(
          event,
          focusedSurface?.kind === "preview" ? dispatchPreviewAction : undefined,
        )
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1" data-right-panel-panes>
        {panes.flatMap((column, columnIndex) => [
          columnIndex === 0 ? null : (
            <RightPanelPaneDivider
              key={`divider:${column[0]!.kind}`}
              axis="x"
              onResize={(before, after) =>
                onResizePanes({
                  [panes[columnIndex - 1]![0]!.kind]: { width: before },
                  [column[0]!.kind]: { width: after },
                })
              }
            />
          ),
          <div
            key={column[0]!.kind}
            className={cn(
              "flex min-h-0 min-w-0 basis-0 flex-col",
              columnIndex > 0 && "border-l border-border",
            )}
            style={{ flexGrow: paneSizes?.[column[0]!.kind]?.width ?? 1 }}
            data-right-panel-pane-column
          >
            {column.flatMap((pane, row) => {
              const topRight = row === 0 && columnIndex === panes.length - 1;
              const focused = pane.activeSurface.id === tabs.activeSurfaceId;
              return [
                row === 0 ? null : (
                  <RightPanelPaneDivider
                    key={`divider:${pane.kind}`}
                    axis="y"
                    onResize={(before, after) =>
                      onResizePanes({
                        [column[row - 1]!.kind]: { height: before },
                        [pane.kind]: { height: after },
                      })
                    }
                  />
                ),
                <RightPanelTabs
                  key={pane.kind}
                  {...tabs}
                  surfaces={pane.surfaces}
                  activeSurfaceId={pane.activeSurface.id}
                  layoutControls={topRight ? cornerControls : undefined}
                  onCloseOtherSurfaces={(surface) => {
                    for (const other of pane.surfaces) {
                      if (other.id !== surface.id) tabs.onCloseSurface(other);
                    }
                  }}
                  onCloseSurfacesToRight={(surface) => {
                    const index = pane.surfaces.findIndex((entry) => entry.id === surface.id);
                    for (const other of pane.surfaces.slice(index + 1)) tabs.onCloseSurface(other);
                  }}
                  onCloseAllSurfaces={() => {
                    for (const surface of pane.surfaces) tabs.onCloseSurface(surface);
                  }}
                  {...(moveSurface
                    ? {
                        // The strip counts within its pane; the store counts across every tab.
                        onMoveSurface: (surfaceId: string, toIndex: number) => {
                          const target = pane.surfaces[toIndex];
                          const index = tabs.surfaces.findIndex(
                            (surface) => surface.id === target?.id,
                          );
                          if (index >= 0) moveSurface(surfaceId, index);
                        },
                      }
                    : {})}
                  pane={{
                    topLeft: row === 0 && columnIndex === 0,
                    topRight,
                    focused,
                    className: cn("basis-0", row > 0 && "border-t border-border"),
                    style: { flexGrow: paneSizes?.[pane.kind]?.height ?? 1 },
                    controls: (
                      <RightPanelPaneMenu
                        layout={layout}
                        kind={pane.kind}
                        onMove={onMovePane}
                        onHide={onHidePane}
                      />
                    ),
                    onFocus: () => {
                      if (!focused) tabs.onActivate(pane.activeSurface);
                    },
                  }}
                >
                  {renderPane(pane.activeSurface)}
                </RightPanelTabs>,
              ];
            })}
          </div>,
        ])}
      </div>
    </PreviewPanelShell>
  );
}

function DeviceTabTooltip(props: {
  surface: Extract<RightPanelSurface, { kind: "device" }>;
  environmentId: EnvironmentId | null;
  title: string;
}) {
  const target = props.surface.target;
  const { state } = useDeviceState(target ? props.environmentId : null);
  const device = target
    ? state.devices.find((entry) => entry.hostId === target.hostId && entry.id === target.deviceId)
    : undefined;
  const host = target ? state.hosts.find((entry) => entry.id === target.hostId) : undefined;
  return (
    <div className="flex flex-col gap-0.5">
      <span>{props.title}</span>
      {target ? (
        <span className="text-muted-foreground">
          {host?.label ?? "Device host"} ·{" "}
          {device?.version ?? (target.platform === "ios" ? "iOS" : "Android")}
        </span>
      ) : null}
    </div>
  );
}
