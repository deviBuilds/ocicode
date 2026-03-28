import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { type ProjectScript, type ThreadId } from "@ocicode/contracts";

import { ChatHeader } from "./ChatHeader";

vi.mock("../GitActionsControl", () => ({
  default: () => <div data-testid="git-actions" />,
}));

vi.mock("../ProjectScriptsControl", () => ({
  default: () => <div data-testid="project-scripts" />,
}));

vi.mock("./OpenInPicker", () => ({
  OpenInPicker: () => <div data-testid="open-in-picker" />,
}));

vi.mock("../ui/sidebar", () => ({
  SidebarTrigger: () => <button type="button">Sidebar</button>,
}));

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("ChatHeader", () => {
  const baseProps = {
    activeThreadId: "thread-1" as ThreadId,
    activeThreadTitle: "Refactor chat shell",
    activeProjectName: "workspace",
    isGitRepo: true,
    openInCwd: "/repo/workspace",
    activeProjectScripts: [] as ProjectScript[],
    preferredScriptId: null,
    keybindings: [],
    availableEditors: [],
    terminalAvailable: true,
    terminalOpen: false,
    terminalToggleShortcutLabel: "Cmd+J",
    diffToggleShortcutLabel: "Cmd+D",
    gitCwd: "/repo/workspace",
    diffOpen: false,
    onRunProjectScript: () => {},
    onAddProjectScript: async () => {},
    onUpdateProjectScript: async () => {},
    onDeleteProjectScript: async () => {},
    onToggleTerminal: () => {},
    onToggleDiff: () => {},
  };

  it("renders a disabled terminal toggle when no project terminal is available", () => {
    const markup = renderToStaticMarkup(
      <ChatHeader {...baseProps} terminalAvailable={false} terminalToggleShortcutLabel={null} />,
    );

    expect(markup).toContain('aria-label="Toggle terminal drawer"');
    expect(markup).toMatch(/aria-label="Toggle terminal drawer"[^>]*disabled/);
  });

  it("marks the terminal toggle as pressed when the drawer is open", () => {
    const markup = renderToStaticMarkup(<ChatHeader {...baseProps} terminalOpen />);

    expect(markup).toContain('aria-label="Toggle terminal drawer"');
    expect(markup).toMatch(
      /aria-label="Toggle terminal drawer"[^>]*(aria-pressed="true"|data-pressed)/,
    );
  });
});
