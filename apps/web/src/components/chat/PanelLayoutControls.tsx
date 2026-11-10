import {
  EllipsisIcon,
  FileDiffIcon,
  FolderIcon,
  GlobeIcon,
  ListIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  Minimize2Icon,
  PanelRightIcon,
  SmartphoneIcon,
  TerminalIcon,
  type LucideIcon,
} from "lucide-react";
import { T, useGT } from "gt-react";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { memo, type ReactNode, useLayoutEffect, useRef } from "react";

import { cn } from "~/lib/utils";

import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { PopoverCreateHandle, PopoverTrigger } from "../ui/popover";
import { useMobileSidebarSheetMounted } from "../ui/sidebar";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Matches the right inset of `ChatHeaderPanelControls`. */
const THREAD_PANEL_HEADER_INSET_PX = 12;

export interface PanelLayoutControlsProps {
  showThreadPanelControl?: boolean;
  showTerminalControl?: boolean;
  showRightPanelControl?: boolean;
  /** Direct surface buttons, placed after the terminal toggle. */
  surfaceControls?: ReactNode;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  threadPanelOpen: boolean;
  threadPanelPresentation: ThreadPanelPresentation;
  threadPanelPopoverHandle?: ReturnType<typeof PopoverCreateHandle>;
  threadPanelShortcutLabel: string | null;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  rightPanelUnavailableLabel?: string;
  onToggleTerminal: () => void;
  onToggleThreadPanel: () => void;
  onToggleRightPanel: () => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  showThreadPanelControl = true,
  showTerminalControl = true,
  showRightPanelControl = true,
  surfaceControls,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  threadPanelOpen,
  threadPanelPresentation,
  threadPanelPopoverHandle,
  threadPanelShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  rightPanelUnavailableLabel,
  onToggleTerminal,
  onToggleThreadPanel,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  const gt = useGT();
  const threadPanelToggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={threadPanelOpen}
      onPressedChange={threadPanelPresentation === "popover" ? undefined : onToggleThreadPanel}
      aria-label={gt("Toggle thread details panel")}
      variant="ghost"
      size="sm"
    >
      <ListIcon className="size-4" />
    </Toggle>
  );
  const threadPanelControl = (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" data-thread-panel-toggle />}>
        {threadPanelPresentation === "popover" ? (
          <PopoverTrigger handle={threadPanelPopoverHandle} render={threadPanelToggle} />
        ) : (
          threadPanelToggle
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {threadPanelShortcutLabel
          ? gt("Toggle thread details ({shortcut})", { shortcut: threadPanelShortcutLabel })
          : gt("Toggle thread details")}
      </TooltipPopup>
    </Tooltip>
  );

  return (
    <div
      className="flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
      data-panel-layout-controls
    >
      {showThreadPanelControl ? threadPanelControl : null}
      {showTerminalControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={terminalOpen}
              onPressedChange={onToggleTerminal}
              aria-label={gt("Toggle terminal")}
              variant="ghost"
              size="sm"
              disabled={!terminalAvailable}
            >
              <TerminalIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? terminalShortcutLabel
                ? gt("Toggle terminal ({shortcut})", { shortcut: terminalShortcutLabel })
                : gt("Toggle terminal")
              : gt("Terminal is unavailable")}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {surfaceControls}
      {showRightPanelControl ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <Toggle
              className="shrink-0 [-webkit-app-region:no-drag]"
              pressed={rightPanelOpen}
              onPressedChange={onToggleRightPanel}
              aria-label={gt("Toggle right panel")}
              data-right-panel-toggle
              variant="ghost"
              size="sm"
              disabled={!rightPanelAvailable}
            >
              <PanelRightIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {rightPanelAvailable
              ? rightPanelShortcutLabel
                ? gt("Toggle right panel ({shortcut})", { shortcut: rightPanelShortcutLabel })
                : gt("Toggle right panel")
              : (rightPanelUnavailableLabel ?? gt("Right panel is unavailable"))}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
});

export interface PanelSurfaceControlsProps {
  diffAvailable: boolean;
  diffOpen: boolean;
  diffShortcutLabel: string | null;
  onToggleDiff: () => void;
  browserAvailable: boolean;
  browserOpen: boolean;
  onToggleBrowser: () => void;
  filesAvailable: boolean;
  filesOpen: boolean;
  onToggleFiles: () => void;
  sideChatAvailable: boolean;
  onOpenSideChat: (() => void) | undefined;
  deviceAvailable: boolean;
  onOpenDevice: () => void;
  pullRequestAvailable: boolean;
  onOpenPullRequest: () => void;
  pullRequestsAvailable: boolean;
  onOpenPullRequests: () => void;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelShortcutLabel: string | null;
  onToggleRightPanel: () => void;
}

function SurfaceToggle(props: {
  label: string;
  toggleLabel: string;
  unavailableLabel: string;
  shortcutLabel?: string | null;
  icon: LucideIcon;
  available: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = props.icon;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={props.open}
          onPressedChange={props.onToggle}
          aria-label={props.toggleLabel}
          variant="ghost"
          size="sm"
          disabled={!props.available}
        >
          <Icon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.available
          ? props.shortcutLabel
            ? `${props.label} (${props.shortcutLabel})`
            : props.label
          : props.unavailableLabel}
      </TooltipPopup>
    </Tooltip>
  );
}

/** One button per everyday surface; the rest, and the whole-panel toggle, sit under More. */
export const PanelSurfaceControls = memo(function PanelSurfaceControls(
  props: PanelSurfaceControlsProps,
) {
  const gt = useGT();
  return (
    <>
      <SurfaceToggle
        label={gt("Diff")}
        toggleLabel={gt("Toggle diff")}
        unavailableLabel={gt("Diff is unavailable")}
        shortcutLabel={props.diffShortcutLabel}
        icon={FileDiffIcon}
        available={props.diffAvailable}
        open={props.diffOpen}
        onToggle={props.onToggleDiff}
      />
      <SurfaceToggle
        label={gt("Browser")}
        toggleLabel={gt("Toggle browser")}
        unavailableLabel={gt("Browser is unavailable")}
        icon={GlobeIcon}
        available={props.browserAvailable}
        open={props.browserOpen}
        onToggle={props.onToggleBrowser}
      />
      <SurfaceToggle
        label={gt("Files")}
        toggleLabel={gt("Toggle files")}
        unavailableLabel={gt("Files are unavailable")}
        icon={FolderIcon}
        available={props.filesAvailable}
        open={props.filesOpen}
        onToggle={props.onToggleFiles}
      />
      <Menu>
        <Tooltip>
          <TooltipTrigger render={<span className="flex shrink-0" />}>
            <MenuTrigger
              render={
                <Button
                  aria-label={gt("More panels")}
                  className="shrink-0 [-webkit-app-region:no-drag]"
                  // Focus returns here when the right panel collapses.
                  data-right-panel-toggle
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <EllipsisIcon className="size-4" />
            </MenuTrigger>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            <T>More panels</T>
          </TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="bottom" sideOffset={6}>
          {props.onOpenSideChat ? (
            <MenuItem disabled={!props.sideChatAvailable} onClick={props.onOpenSideChat}>
              <MessagesSquareIcon />
              <MenuItemLabel>
                <T>Side chat</T>
              </MenuItemLabel>
            </MenuItem>
          ) : null}
          <MenuItem disabled={!props.deviceAvailable} onClick={props.onOpenDevice}>
            <SmartphoneIcon />
            <MenuItemLabel>
              <T>Device</T>
            </MenuItemLabel>
          </MenuItem>
          <MenuItem disabled={!props.pullRequestAvailable} onClick={props.onOpenPullRequest}>
            <PullRequestGlyph.pullRequest />
            <MenuItemLabel>
              <T>Pull request</T>
            </MenuItemLabel>
          </MenuItem>
          <MenuItem disabled={!props.pullRequestsAvailable} onClick={props.onOpenPullRequests}>
            <PullRequestGlyph.link />
            <MenuItemLabel>
              <T>Linked pull requests</T>
            </MenuItemLabel>
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!props.rightPanelAvailable} onClick={props.onToggleRightPanel}>
            <PanelRightIcon />
            <MenuItemLabel>
              {props.rightPanelOpen ? <T>Hide right panel</T> : <T>Show right panel</T>}
            </MenuItemLabel>
            {props.rightPanelShortcutLabel ? (
              <MenuShortcut>{props.rightPanelShortcutLabel}</MenuShortcut>
            ) : null}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
});

export const RightPanelMaximizeControl = memo(function RightPanelMaximizeControl({
  maximized,
  onToggle,
}: {
  maximized: boolean;
  onToggle: () => void;
}) {
  const gt = useGT();
  const label = maximized ? gt("Restore panel size") : gt("Maximize panel");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className="shrink-0 [-webkit-app-region:no-drag]"
            pressed={maximized}
            onPressedChange={onToggle}
            aria-label={label}
            variant="ghost"
            size="sm"
          >
            {maximized ? (
              <Minimize2Icon className="size-4" />
            ) : (
              <Maximize2Icon className="size-4" />
            )}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
});

/** The panel buttons at the end of the chat header, where they stay while panes fill the corner. */
export function ChatHeaderPanelControls(props: { readonly children: ReactNode }) {
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  return (
    <div
      className={cn(
        "absolute top-[var(--workspace-controls-top)] right-[calc(env(safe-area-inset-right)+0.75rem)] z-50 flex h-[var(--workspace-topbar-height)] items-center [-webkit-app-region:no-drag]",
        mobileSidebarSheetMounted && "hidden",
      )}
      data-workspace-titlebar-controls
    >
      {props.children}
    </div>
  );
}

/** The window's top-right panel controls, with the maximize toggle while the panel is open. */
export function WorkspaceTitlebarControls(props: {
  readonly showMaximizeControl: boolean;
  readonly rightPanelOpen: boolean;
  readonly animationsActive: boolean;
  readonly maximized: boolean;
  readonly onToggleMaximized: () => void;
  readonly children: ReactNode;
}) {
  const { rightPanelOpen, maximized } = props;
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const previous = useRef({ rightPanelOpen, maximized });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the toggle's slide before the commit that swapped it in paints; the animation is cancelled on change or unmount.
  useLayoutEffect(() => {
    const { rightPanelOpen: wasOpen, maximized: wasMaximized } = previous.current;
    previous.current = { rightPanelOpen, maximized };
    if (!wasOpen || rightPanelOpen || wasMaximized) return;
    // In this build the whole button group sat at the header's end, not only the details toggle.
    const toggle = controlsRef.current?.querySelector("[data-panel-layout-controls]");
    const panel = toggle?.ownerDocument.querySelector("[data-preview-panel-mode='inline']");
    const timing = panel?.getAnimations()[0]?.effect?.getTiming();
    if (!toggle || !panel || !timing) return;
    // The header's buttons were just removed, so slide these in from where they sat.
    const headerRight = panel.getBoundingClientRect().left - THREAD_PANEL_HEADER_INSET_PX;
    const offset = headerRight - toggle.getBoundingClientRect().right;
    const animation = toggle.animate(
      [{ transform: `translateX(${offset}px)` }, { transform: "none" }],
      { ...timing, easing: getComputedStyle(panel).transitionTimingFunction },
    );
    return () => animation.cancel();
  }, [rightPanelOpen, maximized]);

  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  return (
    <div
      ref={controlsRef}
      className={cn(
        "pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
        mobileSidebarSheetMounted && "hidden",
      )}
      data-workspace-titlebar-controls
    >
      {props.showMaximizeControl ? (
        <span
          aria-hidden={!props.rightPanelOpen}
          // Fading out on close would show it beside the thread details toggle that replaces it.
          className={cn(
            "flex shrink-0",
            props.rightPanelOpen &&
              props.animationsActive &&
              "motion-safe:transition-opacity motion-safe:duration-(--panel-animation-duration) motion-safe:ease-out",
            props.rightPanelOpen
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none absolute right-full mr-1 opacity-0",
          )}
          inert={!props.rightPanelOpen}
        >
          <RightPanelMaximizeControl
            maximized={props.maximized}
            onToggle={props.onToggleMaximized}
          />
        </span>
      ) : null}
      <div className="pointer-events-auto flex h-full items-center">{props.children}</div>
    </div>
  );
}
