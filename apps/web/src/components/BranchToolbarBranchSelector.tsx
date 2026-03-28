import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { GitBranch } from "@ocicode/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import { isElectron } from "../env";
import {
  gitBranchesQueryOptions,
  gitQueryKeys,
  gitStatusQueryOptions,
  invalidateGitQueries,
} from "../lib/gitReactQuery";
import { cn, isMacPlatform } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  EnvMode,
  resolveBranchToolbarValue,
} from "./BranchToolbar.logic";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import { ScrollArea } from "./ui/scroll-area";
import { toastManager } from "./ui/toast";

interface BranchToolbarBranchSelectorProps {
  activeProjectCwd: string;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  onSetThreadBranch: (branch: string | null, worktreePath: string | null) => void;
  onComposerFocusRequest?: () => void;
}

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function getBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
}): string {
  const { activeWorktreePath, effectiveEnvMode, resolvedActiveBranch } = input;
  if (!resolvedActiveBranch) {
    return "Select branch";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    return `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

function getBranchMetaLabel(input: {
  branch: GitBranch;
  activeProjectCwd: string;
  isCurrentBranch: boolean;
}): string {
  const { activeProjectCwd, branch, isCurrentBranch } = input;
  if (isCurrentBranch) {
    return "Current branch";
  }
  if (branch.worktreePath && branch.worktreePath !== activeProjectCwd) {
    return "Linked worktree";
  }
  if (branch.isRemote) {
    return "Remote branch";
  }
  if (branch.isDefault) {
    return "Default branch";
  }
  return "Local branch";
}

function BranchGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="4" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.75" cy="5.5" r="1.75" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4 5.25v5.5M5.5 4.35c.6.95 1.55 1.55 2.85 1.8h1.55"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BranchToolbarBranchSelector({
  activeProjectCwd,
  activeThreadBranch,
  activeWorktreePath,
  branchCwd,
  effectiveEnvMode,
  envLocked,
  onSetThreadBranch,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  const queryClient = useQueryClient();
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const branchSearchInputRef = useRef<HTMLInputElement | null>(null);

  const branchesQuery = useQuery(gitBranchesQueryOptions(branchCwd));
  const branchStatusQuery = useQuery(gitStatusQueryOptions(branchCwd));
  const branches = useMemo(
    () => dedupeRemoteBranchesWithLocalMatches(branchesQuery.data?.branches ?? []),
    [branchesQuery.data?.branches],
  );
  const currentGitBranch = branches.find((branch) => branch.current)?.name ?? null;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
  });
  const branchNames = useMemo(() => branches.map((branch) => branch.name), [branches]);
  const branchByName = useMemo(
    () => new Map(branches.map((branch) => [branch.name, branch] as const)),
    [branches],
  );
  const trimmedBranchQuery = branchQuery.trim();
  const normalizedBranchQuery = trimmedBranchQuery.toLowerCase();
  const canCreateBranch = effectiveEnvMode === "local" && trimmedBranchQuery.length > 0;
  const hasExactBranchMatch = branchByName.has(trimmedBranchQuery);
  const filteredBranchPickerItems = useMemo(
    () =>
      normalizedBranchQuery.length === 0
        ? branchNames
        : branchNames.filter((itemValue) =>
            itemValue.toLowerCase().includes(normalizedBranchQuery),
          ),
    [branchNames, normalizedBranchQuery],
  );
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const useMacVibrancy =
    isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform);

  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action().catch(() => undefined);
      await invalidateGitQueries(queryClient).catch(() => undefined);
    });
  };

  const selectBranch = (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !branchCwd || isBranchActionPending) return;

    // In new-worktree mode, selecting a branch sets the base branch.
    if (effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath) {
      onSetThreadBranch(branch.name, null);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    // If the branch already lives in a worktree, point the thread there.
    if (branch.worktreePath) {
      const isMainWorktree = branch.worktreePath === activeProjectCwd;
      onSetThreadBranch(branch.name, isMainWorktree ? null : branch.worktreePath);
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = branch.isRemote
      ? deriveLocalBranchNameFromRemoteRef(branch.name)
      : branch.name;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(selectedBranchName);
      try {
        await api.git.checkout({ cwd: branchCwd, branch: branch.name });
        await invalidateGitQueries(queryClient);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to checkout branch.",
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      let nextBranchName = selectedBranchName;
      if (branch.isRemote) {
        const status = await api.git.status({ cwd: branchCwd }).catch(() => null);
        if (status?.branch) {
          nextBranchName = status.branch;
        }
      }

      setOptimisticBranch(nextBranchName);
      onSetThreadBranch(nextBranchName, activeWorktreePath);
    });
  };

  const createBranch = (rawName: string) => {
    const name = rawName.trim();
    const api = readNativeApi();
    if (!api || !branchCwd || !name || isBranchActionPending) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(name);

      try {
        await api.git.createBranch({ cwd: branchCwd, branch: name });
        try {
          await api.git.checkout({ cwd: branchCwd, branch: name });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to checkout branch.",
            description: toBranchActionErrorMessage(error),
          });
          return;
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to create branch.",
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      setOptimisticBranch(name);
      onSetThreadBranch(name, activeWorktreePath);
      setBranchQuery("");
    });
  };

  useEffect(() => {
    if (
      effectiveEnvMode !== "worktree" ||
      activeWorktreePath ||
      activeThreadBranch ||
      !currentGitBranch
    ) {
      return;
    }
    onSetThreadBranch(currentGitBranch, null);
  }, [
    activeThreadBranch,
    activeWorktreePath,
    currentGitBranch,
    effectiveEnvMode,
    onSetThreadBranch,
  ]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsBranchMenuOpen(open);
      if (!open) {
        setBranchQuery("");
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: gitQueryKeys.branches(branchCwd),
      });
    },
    [branchCwd, queryClient],
  );

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
  });

  return (
    <Combobox
      items={branchNames}
      filteredItems={filteredBranchPickerItems}
      autoHighlight
      onOpenChange={handleOpenChange}
      open={isBranchMenuOpen}
      value={resolvedActiveBranch}
    >
      <ComboboxTrigger
        render={<Button variant="ghost" size="xs" />}
        className={cn(
          "branch-selector-pill h-9 rounded-[1rem] border px-3.5 text-[12px] font-medium text-white/84 shadow-none transition-colors",
          useMacVibrancy
            ? "border-white/8 bg-[rgba(40,40,40,0.56)] supports-[backdrop-filter]:bg-[rgba(40,40,40,0.38)] supports-[backdrop-filter]:backdrop-blur-[22px] supports-[backdrop-filter]:backdrop-saturate-[1.55] hover:bg-[rgba(48,48,48,0.48)]"
            : "border-white/8 bg-[rgba(40,40,40,0.86)] hover:bg-[rgba(48,48,48,0.94)]",
        )}
        disabled={branchesQuery.isLoading || isBranchActionPending || !branchCwd}
      >
        <BranchGlyph className="size-3.5 text-white/58" />
        <span className="max-w-[240px] truncate">{triggerLabel}</span>
        <ChevronDownIcon className="size-3.5 text-white/48" />
      </ComboboxTrigger>
      <ComboboxPopup
        align="end"
        side="top"
        sideOffset={8}
        className={cn(
          "branch-selector-popover w-[22.5rem] overflow-hidden rounded-[1.75rem] border border-white/8 p-0 text-white shadow-[0_12px_32px_rgba(0,0,0,0.16)] before:hidden",
          useMacVibrancy
            ? "bg-[rgba(36,36,36,0.72)] supports-[backdrop-filter]:bg-[rgba(36,36,36,0.48)] supports-[backdrop-filter]:backdrop-blur-[30px] supports-[backdrop-filter]:backdrop-saturate-[1.75]"
            : "bg-[rgba(36,36,36,0.96)]",
        )}
      >
        <div className="px-3 pt-3 pb-0">
          <div className="flex h-12 items-center gap-3 rounded-[1.15rem] border border-white/[0.06] bg-white/[0.035] px-4">
            <SearchIcon className="size-5 shrink-0 text-white/48" />
            <ComboboxPrimitive.Input
              className="h-full min-w-0 flex-1 bg-transparent font-sans text-[15px] leading-none text-white outline-none placeholder:text-white/34"
              placeholder="Search branches..."
              type="search"
              value={branchQuery}
              onChange={(event) => setBranchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !canCreateBranch || hasExactBranchMatch) return;
                event.preventDefault();
                createBranch(trimmedBranchQuery);
              }}
              ref={branchSearchInputRef}
            />
          </div>
        </div>
        <ComboboxEmpty className="px-5 pb-4 pt-2 text-left text-sm text-white/40">
          No branches found.
        </ComboboxEmpty>

        <ScrollArea className="max-h-[16rem] px-2 pb-2">
          <div className="px-3 pt-0 pb-4 text-[13px] leading-none font-medium tracking-[0.01em] text-white/42">
            Branches
          </div>
          <ComboboxPrimitive.List className="space-y-1" data-slot="combobox-list">
            {filteredBranchPickerItems.map((itemValue, index) => {
              const branch = branchByName.get(itemValue);
              if (!branch) return null;

              const isActiveBranch = itemValue === resolvedActiveBranch;
              const isCurrentBranch =
                branch.current || branchStatusQuery.data?.branch === branch.name;
              const changedFilesCount = branchStatusQuery.data?.workingTree.files.length ?? 0;
              const hasWorkingTreeChanges =
                isCurrentBranch && Boolean(branchStatusQuery.data?.hasWorkingTreeChanges);
              const secondaryLabel = getBranchMetaLabel({
                branch,
                activeProjectCwd,
                isCurrentBranch,
              });

              return (
                <ComboboxItem
                  hideIndicator
                  key={itemValue}
                  index={index}
                  value={itemValue}
                  className={cn(
                    "rounded-[1rem] border border-transparent px-3 py-2.5 text-white transition-[background-color,border-color,color] duration-150 hover:border-white/[0.05] hover:bg-white/[0.065] hover:text-white hover:[&_svg.branch-row-icon]:text-white/88 hover:[&_.branch-row-meta]:text-white/54 data-highlighted:border-white/[0.05] data-highlighted:bg-white/[0.065] data-highlighted:text-white data-highlighted:[&_svg.branch-row-icon]:text-white/88 data-highlighted:[&_.branch-row-meta]:text-white/54",
                    isActiveBranch && "border-white/[0.05] bg-white/[0.05]",
                  )}
                  onClick={() => selectBranch(branch)}
                >
                  <div className="flex w-full items-start gap-3">
                    <BranchGlyph className="branch-row-icon mt-0.5 size-4 shrink-0 text-white/72 transition-colors duration-150" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-3">
                        <span className="truncate text-[15px] font-semibold tracking-[0.01em] text-white">
                          {itemValue}
                        </span>
                        {isActiveBranch ? (
                          <CheckIcon className="ml-auto mt-0.5 size-4.5 shrink-0 text-white" />
                        ) : null}
                      </div>
                      {hasWorkingTreeChanges ? (
                        <div className="branch-row-meta mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-white/42 transition-colors duration-150">
                          <span>
                            Uncommitted: {changedFilesCount} file
                            {changedFilesCount === 1 ? "" : "s"}
                          </span>
                          <span className="font-medium text-[#39cf89]">
                            +{branchStatusQuery.data?.workingTree.insertions ?? 0}
                          </span>
                          <span className="font-medium text-[#ff5f58]">
                            -{branchStatusQuery.data?.workingTree.deletions ?? 0}
                          </span>
                        </div>
                      ) : (
                        <div className="branch-row-meta mt-1 text-[12px] text-white/38 transition-colors duration-150">
                          {secondaryLabel}
                        </div>
                      )}
                    </div>
                  </div>
                </ComboboxItem>
              );
            })}
          </ComboboxPrimitive.List>
        </ScrollArea>
        {effectiveEnvMode === "local" ? (
          <div className="border-white/8 border-t px-3 py-3">
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-3 rounded-[1.05rem] px-3 py-2.5 text-left text-[14px] font-medium text-white transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/12",
                !canCreateBranch || hasExactBranchMatch ? "text-white/78" : "text-white",
              )}
              onClick={() => {
                if (!canCreateBranch || hasExactBranchMatch) {
                  branchSearchInputRef.current?.focus();
                  return;
                }
                createBranch(trimmedBranchQuery);
              }}
            >
              <PlusIcon className="size-4.5 shrink-0 text-white/72" />
              <span className="truncate">
                {canCreateBranch && !hasExactBranchMatch
                  ? `Create and checkout "${trimmedBranchQuery}"`
                  : "Create and checkout new branch..."}
              </span>
            </button>
          </div>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  );
}
