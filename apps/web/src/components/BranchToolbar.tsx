import { type RuntimeMode, type ThreadId } from "@ocicode/contracts";
import { type ReactNode, useCallback } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { CHAT_COMPOSER_MAX_WIDTH } from "../chatShellLayout";
import { newCommandId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useStore } from "../store";
import {
  EnvMode,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

interface BranchToolbarProps {
  threadId: ThreadId;
  onEnvModeChange: (mode: EnvMode) => void;
  envLocked: boolean;
  isGitRepo: boolean;
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onComposerFocusRequest?: () => void;
}

function StatusPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-8 items-center rounded-full border border-border/80 bg-background/72 px-3 text-[11px] font-medium tracking-[0.01em] text-muted-foreground/82">
      {children}
    </span>
  );
}

function RuntimeModeIcon({ mode, className }: { mode: RuntimeMode; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={className}>
      <path
        d="M10 1.9 16.2 4.8v4.8c0 4.2-2.6 7.2-6.2 8.5-3.6-1.3-6.2-4.3-6.2-8.5V4.8L10 1.9Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      {mode === "full-access" ? (
        <>
          <path d="M10 6.2v4.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="10" cy="13.6" r="1.05" fill="currentColor" />
        </>
      ) : (
        <path
          d="M7.5 10.2 9.3 12l3.4-3.8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function runtimeModeMeta(mode: RuntimeMode): {
  label: string;
  triggerClassName: string;
  iconClassName: string;
} {
  if (mode === "full-access") {
    return {
      label: "Full access",
      triggerClassName:
        "border-[#ff8a42]/28 bg-[#2a201a] text-[#ff8a42] hover:border-[#ff8a42]/36 hover:bg-[#32261f] hover:text-[#ff9a5a]",
      iconClassName: "text-[#ff8a42]",
    };
  }

  return {
    label: "Approval required",
    triggerClassName:
      "border-border/80 bg-background/80 text-foreground/82 hover:bg-accent hover:text-foreground",
    iconClassName: "text-foreground/72",
  };
}

export default function BranchToolbar({
  threadId,
  onEnvModeChange,
  envLocked,
  isGitRepo,
  runtimeMode,
  onRuntimeModeChange,
  onComposerFocusRequest,
}: BranchToolbarProps) {
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) => store.getDraftThread(threadId));
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const serverThread = threads.find((thread) => thread.id === threadId);
  const activeProjectId = serverThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch = serverThread?.branch ?? draftThread?.branch ?? null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const branchCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread,
    draftThreadEnvMode: draftThread?.envMode,
  });

  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId) return;
      const api = readNativeApi();
      // If the effective cwd is about to change, stop the running session so the
      // next message creates a new one with the correct cwd.
      if (serverThread?.session && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }
      if (hasServerThread) {
        setThreadBranchAction(activeThreadId, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(threadId, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
      });
    },
    [
      activeThreadId,
      serverThread?.session,
      activeWorktreePath,
      hasServerThread,
      setThreadBranchAction,
      setDraftThreadContext,
      threadId,
      effectiveEnvMode,
    ],
  );

  if (!activeThreadId || !activeProject) return null;

  const envLabel = activeWorktreePath ? "Worktree" : "Local";
  const canToggleEnvMode = !envLocked && !activeWorktreePath;
  const activeRuntimeMode = runtimeModeMeta(runtimeMode);
  const runtimeModeOptions: RuntimeMode[] = ["approval-required", "full-access"];

  return (
    <div className="chat-shell-surface px-4 py-2">
      <div
        className="mx-auto flex w-full flex-wrap items-center gap-2"
        style={{ maxWidth: CHAT_COMPOSER_MAX_WIDTH }}
      >
        {canToggleEnvMode ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 rounded-full border border-border bg-background/92 px-3 text-[11px] font-medium text-foreground/82 shadow-xs/5 hover:bg-accent hover:text-foreground"
            size="xs"
            onClick={() => onEnvModeChange(effectiveEnvMode === "local" ? "worktree" : "local")}
          >
            {effectiveEnvMode === "worktree" ? "New worktree" : "Local"}
          </Button>
        ) : (
          <StatusPill>{envLabel}</StatusPill>
        )}

        <Menu>
          <MenuTrigger
            render={<Button type="button" variant="ghost" size="xs" aria-label="Runtime mode" />}
            className={`h-8 rounded-full border px-3 text-[11px] font-medium shadow-xs/5 ${activeRuntimeMode.triggerClassName}`}
          >
            <RuntimeModeIcon
              mode={runtimeMode}
              className={`size-4 ${activeRuntimeMode.iconClassName}`}
            />
            <span>{activeRuntimeMode.label}</span>
            <ChevronDownIcon className="size-3.5 opacity-80" />
          </MenuTrigger>
          <MenuPopup
            align="start"
            side="top"
            className="w-[15.5rem] rounded-[1.4rem] border-white/6 bg-[#232323]/98 p-1.5 text-white shadow-[0_22px_60px_rgba(0,0,0,0.45)] supports-[backdrop-filter]:bg-[#232323]/92 supports-[backdrop-filter]:backdrop-blur-xl"
          >
            {runtimeModeOptions.map((modeOption) => {
              const optionMeta = runtimeModeMeta(modeOption);
              const selected = runtimeMode === modeOption;
              return (
                <MenuItem
                  key={modeOption}
                  className="min-h-12 rounded-[1rem] px-3 py-2 text-[15px] text-white data-highlighted:bg-white/6 data-highlighted:text-white"
                  onClick={() => onRuntimeModeChange(modeOption)}
                >
                  <RuntimeModeIcon
                    mode={modeOption}
                    className={`size-5 ${optionMeta.iconClassName}`}
                  />
                  <span className="flex-1">{optionMeta.label}</span>
                  {selected ? <CheckIcon className="size-4.5 text-white" /> : null}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          {isGitRepo ? (
            <BranchToolbarBranchSelector
              activeProjectCwd={activeProject.cwd}
              activeThreadBranch={activeThreadBranch}
              activeWorktreePath={activeWorktreePath}
              branchCwd={branchCwd}
              effectiveEnvMode={effectiveEnvMode}
              envLocked={envLocked}
              onSetThreadBranch={setThreadBranch}
              {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
            />
          ) : (
            <StatusPill>No Git</StatusPill>
          )}
        </div>
      </div>
    </div>
  );
}
