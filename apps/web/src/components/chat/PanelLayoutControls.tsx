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
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { memo, type ReactNode } from "react";

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
  rightPanelUnavailableLabel = "Right panel is unavailable",
  onToggleTerminal,
  onToggleThreadPanel,
  onToggleRightPanel,
}: PanelLayoutControlsProps) {
  const threadPanelToggle = (
    <Toggle
      className="relative shrink-0 [-webkit-app-region:no-drag]"
      pressed={threadPanelOpen}
      onPressedChange={threadPanelPresentation === "popover" ? undefined : onToggleThreadPanel}
      aria-label="Toggle thread details panel"
      variant="ghost"
      size="sm"
    >
      <ListIcon className="size-4" />
    </Toggle>
  );
  const threadPanelControl = (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        {threadPanelPresentation === "popover" ? (
          <PopoverTrigger handle={threadPanelPopoverHandle} render={threadPanelToggle} />
        ) : (
          threadPanelToggle
        )}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Toggle thread details
        {threadPanelShortcutLabel ? ` (${threadPanelShortcutLabel})` : ""}
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
              aria-label="Toggle terminal"
              variant="ghost"
              size="sm"
              disabled={!terminalAvailable}
            >
              <TerminalIcon className="size-4" />
            </Toggle>
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {terminalAvailable
              ? `Toggle terminal${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
              : "Terminal is unavailable"}
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
              aria-label="Toggle right panel"
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
              ? `Toggle right panel${rightPanelShortcutLabel ? ` (${rightPanelShortcutLabel})` : ""}`
              : rightPanelUnavailableLabel}
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
          aria-label={`Toggle ${props.label.toLowerCase()}`}
          variant="ghost"
          size="sm"
          disabled={!props.available}
        >
          <Icon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.available
          ? `${props.label}${props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}`
          : `${props.label} is unavailable`}
      </TooltipPopup>
    </Tooltip>
  );
}

/** One button per everyday surface; the rest, and the whole-panel toggle, sit under More. */
export const PanelSurfaceControls = memo(function PanelSurfaceControls(
  props: PanelSurfaceControlsProps,
) {
  return (
    <>
      <SurfaceToggle
        label="Diff"
        shortcutLabel={props.diffShortcutLabel}
        icon={FileDiffIcon}
        available={props.diffAvailable}
        open={props.diffOpen}
        onToggle={props.onToggleDiff}
      />
      <SurfaceToggle
        label="Browser"
        icon={GlobeIcon}
        available={props.browserAvailable}
        open={props.browserOpen}
        onToggle={props.onToggleBrowser}
      />
      <SurfaceToggle
        label="Files"
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
                  aria-label="More panels"
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
          <TooltipPopup side="bottom">More panels</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="bottom" sideOffset={6}>
          {props.onOpenSideChat ? (
            <MenuItem disabled={!props.sideChatAvailable} onClick={props.onOpenSideChat}>
              <MessagesSquareIcon />
              <MenuItemLabel>Side chat</MenuItemLabel>
            </MenuItem>
          ) : null}
          <MenuItem disabled={!props.deviceAvailable} onClick={props.onOpenDevice}>
            <SmartphoneIcon />
            <MenuItemLabel>Device</MenuItemLabel>
          </MenuItem>
          <MenuItem disabled={!props.pullRequestAvailable} onClick={props.onOpenPullRequest}>
            <PullRequestGlyph.pullRequest />
            <MenuItemLabel>Pull request</MenuItemLabel>
          </MenuItem>
          <MenuItem disabled={!props.pullRequestsAvailable} onClick={props.onOpenPullRequests}>
            <PullRequestGlyph.link />
            <MenuItemLabel>Linked pull requests</MenuItemLabel>
          </MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!props.rightPanelAvailable} onClick={props.onToggleRightPanel}>
            <PanelRightIcon />
            <MenuItemLabel>{props.rightPanelOpen ? "Hide" : "Show"} right panel</MenuItemLabel>
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
  const label = maximized ? "Restore panel size" : "Maximize panel";
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
  const mobileSidebarSheetMounted = useMobileSidebarSheetMounted();
  return (
    <div
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
