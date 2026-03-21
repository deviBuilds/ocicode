import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  GitPullRequestIcon,
  PlusIcon,
  RocketIcon,
  SettingsIcon,
  SquarePenIcon,
  TerminalIcon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_RUNTIME_MODE,
  DEFAULT_MODEL_BY_PROVIDER,
  type DesktopUpdateState,
  ProjectId,
  ThreadId,
  type GitStatusResult,
  type ResolvedKeybindingsConfig,
} from "@ocicode/contracts";
import { makeStorageKey } from "@ocicode/shared/branding";
import { OciWordmark } from "~/components/OciWordmark";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { APP_STAGE_LABEL } from "../branding";
import { newCommandId, newProjectId, newThreadId } from "../lib/utils";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut, shortcutLabelForCommand } from "../keybindings";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { toastManager } from "./ui/toast";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldHighlightDesktopUpdateError,
  shouldShowDesktopUpdateButton,
  shouldToastDesktopUpdateActionResult,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuAction,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarTrigger,
} from "./ui/sidebar";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { isNonEmpty as isNonEmptyString } from "effect/String";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import type { Project, Thread } from "../types";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_THREADS: Thread[] = [];
const THREAD_PREVIEW_LIMIT = 6;
const INTEGRATION_THREAD_IDS_STORAGE_KEY = makeStorageKey("integration-thread-ids:v1");

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard?.writeText === undefined) {
    throw new Error("Clipboard API unavailable.");
  }
  await navigator.clipboard.writeText(text);
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function compareThreadsByCreatedAtDesc(a: Thread, b: Thread): number {
  const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (byDate !== 0) return byDate;
  return b.id.localeCompare(a.id);
}

function readPersistedIntegrationThreadIds(): ReadonlySet<ThreadId> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(INTEGRATION_THREAD_IDS_STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(
      parsed.filter((entry): entry is ThreadId => typeof entry === "string" && entry.length > 0),
    );
  } catch {
    return new Set();
  }
}

function persistIntegrationThreadIds(threadIds: ReadonlySet<ThreadId>): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      INTEGRATION_THREAD_IDS_STORAGE_KEY,
      JSON.stringify([...threadIds]),
    );
  } catch {
    // Ignore persistence issues to avoid breaking the sidebar.
  }
}

interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

type ThreadPr = GitStatusResult["pr"];

function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

/**
 * Derives the server's HTTP origin (scheme + host + port) from the same
 * sources WsTransport uses, converting ws(s) to http(s).
 */
function getServerHttpOrigin(): string {
  const bridgeUrl = window.desktopBridge?.getWsUrl();
  const envUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsUrl =
    bridgeUrl && bridgeUrl.length > 0
      ? bridgeUrl
      : envUrl && envUrl.length > 0
        ? envUrl
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.hostname}:${window.location.port}`;
  // Parse to extract just the origin, dropping path/query (e.g. ?token=…)
  const httpUrl = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  try {
    return new URL(httpUrl).origin;
  } catch {
    return httpUrl;
  }
}

const serverHttpOrigin = getServerHttpOrigin();

/**
 * Derives a stable muted hue from a project name for the accent bar.
 */
function projectAccentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = ((hash % 360) + 360) % 360;
  return `oklch(0.65 0.12 ${hue})`;
}

function ProjectFaviconFallback({ name }: { name: string }) {
  const letter = name.charAt(0).toUpperCase() || "?";
  const bg = projectAccentColor(name);
  return (
    <span
      className="flex size-3.5 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold text-white"
      style={{ backgroundColor: bg }}
    >
      {letter}
    </span>
  );
}

function ProjectFavicon({ cwd, name }: { cwd: string; name: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  const src = `${serverHttpOrigin}/api/project-favicon?cwd=${encodeURIComponent(cwd)}`;

  if (status === "error") {
    return <ProjectFaviconFallback name={name} />;
  }

  return (
    <>
      {status === "loading" && <ProjectFaviconFallback name={name} />}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loading" ? "hidden" : ""}`}
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("error")}
      />
    </>
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearThreadDraft);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const terminalStateByThreadId = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const clearTerminalState = useTerminalStateStore((state) => state.clearTerminalState);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const navigate = useNavigate();
  const isOnSettings = useLocation({ select: (loc) => loc.pathname === "/settings" });
  const { settings: appSettings } = useAppSettings();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const { data: keybindings = EMPTY_KEYBINDINGS } = useQuery({
    ...serverConfigQueryOptions(),
    select: (config) => config.keybindings,
  });
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const [addingProject, setAddingProject] = useState(false);
  const [newCwd, setNewCwd] = useState("");
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const addProjectInputRef = useRef<HTMLInputElement | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<ThreadId | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<ProjectId>
  >(() => new Set());
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [integrationThreadIds, setIntegrationThreadIds] = useState<ReadonlySet<ThreadId>>(() =>
    readPersistedIntegrationThreadIds(),
  );
  const shouldBrowseForProjectImmediately = isElectron;
  const shouldShowProjectPathEntry = addingProject && !shouldBrowseForProjectImmediately;
  const activeThread = routeThreadId ? threads.find((thread) => thread.id === routeThreadId) : null;
  const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
  const pendingApprovalByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingApprovals(thread.activities).length > 0);
    }
    return map;
  }, [threads]);
  const pendingUserInputByThreadId = useMemo(() => {
    const map = new Map<ThreadId, boolean>();
    for (const thread of threads) {
      map.set(thread.id, derivePendingUserInputs(thread.activities).length > 0);
    }
    return map;
  }, [threads]);
  const sortedThreadsByProjectId = useMemo(() => {
    const threadsByProjectId = new Map<ProjectId, Thread[]>();
    for (const project of projects) {
      threadsByProjectId.set(project.id, []);
    }
    for (const thread of threads) {
      if (integrationThreadIds.has(thread.id)) {
        continue;
      }
      const projectThreads = threadsByProjectId.get(thread.projectId);
      if (projectThreads) {
        projectThreads.push(thread);
      }
    }
    for (const projectThreads of threadsByProjectId.values()) {
      projectThreads.sort(compareThreadsByCreatedAtDesc);
    }
    return threadsByProjectId;
  }, [integrationThreadIds, projects, threads]);
  const integrationThreads = useMemo(
    () =>
      threads
        .filter((thread) => integrationThreadIds.has(thread.id))
        .toSorted(compareThreadsByCreatedAtDesc),
    [integrationThreadIds, threads],
  );
  const projectCwdById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.cwd] as const)),
    [projects],
  );
  const threadGitTargets = useMemo(
    () =>
      threads.map((thread) => ({
        threadId: thread.id,
        branch: thread.branch,
        cwd: thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null,
      })),
    [projectCwdById, threads],
  );
  const threadGitStatusCwds = useMemo(
    () => [
      ...new Set(
        threadGitTargets
          .filter((target) => target.branch !== null)
          .map((target) => target.cwd)
          .filter((cwd): cwd is string => cwd !== null),
      ),
    ],
    [threadGitTargets],
  );
  const threadGitStatusQueries = useQueries({
    queries: threadGitStatusCwds.map((cwd) => ({
      ...gitStatusQueryOptions(cwd),
      staleTime: 30_000,
      refetchInterval: 60_000,
    })),
  });
  const prByThreadId = useMemo(() => {
    const statusByCwd = new Map<string, GitStatusResult>();
    for (let index = 0; index < threadGitStatusCwds.length; index += 1) {
      const cwd = threadGitStatusCwds[index];
      if (!cwd) continue;
      const status = threadGitStatusQueries[index]?.data;
      if (status) {
        statusByCwd.set(cwd, status);
      }
    }

    const map = new Map<ThreadId, ThreadPr>();
    for (const target of threadGitTargets) {
      const status = target.cwd ? statusByCwd.get(target.cwd) : undefined;
      const branchMatches =
        target.branch !== null && status?.branch !== null && status?.branch === target.branch;
      map.set(target.threadId, branchMatches ? (status?.pr ?? null) : null);
    }
    return map;
  }, [threadGitStatusCwds, threadGitStatusQueries, threadGitTargets]);

  useEffect(() => {
    persistIntegrationThreadIds(integrationThreadIds);
  }, [integrationThreadIds]);

  useEffect(() => {
    setIntegrationThreadIds((current) => {
      const next = new Set<ThreadId>();
      let changed = false;
      for (const threadId of current) {
        if (threads.some((thread) => thread.id === threadId) || getDraftThread(threadId)) {
          next.add(threadId);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [getDraftThread, threads]);

  const openPrLink = useCallback((event: React.MouseEvent<HTMLElement>, prUrl: string) => {
    event.preventDefault();
    event.stopPropagation();

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Link opening is unavailable.",
      });
      return;
    }

    void api.shell.openExternal(prUrl).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open PR link",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, []);

  const setThreadIntegrationState = useCallback((threadId: ThreadId, isIntegration: boolean) => {
    setIntegrationThreadIds((current) => {
      const alreadyPresent = current.has(threadId);
      if ((isIntegration && alreadyPresent) || (!isIntegration && !alreadyPresent)) {
        return current;
      }
      const next = new Set(current);
      if (isIntegration) {
        next.add(threadId);
      } else {
        next.delete(threadId);
      }
      return next;
    });
  }, []);

  const startThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<ThreadId> => {
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
      if (storedDraftThread) {
        return (async () => {
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(storedDraftThread.threadId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setProjectDraftThreadId(projectId, storedDraftThread.threadId);
          if (routeThreadId === storedDraftThread.threadId) {
            return storedDraftThread.threadId;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
          return storedDraftThread.threadId;
        })();
      }
      clearProjectDraftThreadId(projectId);

      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
      if (activeDraftThread && routeThreadId && activeDraftThread.projectId === projectId) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(routeThreadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, routeThreadId);
        return Promise.resolve(routeThreadId);
      }
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setProjectDraftThreadId(projectId, threadId, {
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
        return threadId;
      })();
    },
    [
      clearProjectDraftThreadId,
      getDraftThreadByProjectId,
      navigate,
      getDraftThread,
      routeThreadId,
      setDraftThreadContext,
      setProjectDraftThreadId,
    ],
  );

  const handleNewThread = useCallback(
    async (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      const threadId = await startThread(projectId, options);
      setThreadIntegrationState(threadId, false);
    },
    [setThreadIntegrationState, startThread],
  );

  const handleNewIntegrationThread = useCallback(async (): Promise<void> => {
    const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id;
    if (!projectId) {
      toastManager.add({
        type: "warning",
        title: "Add a project first",
        description: "Integration threads still need a project workspace before they can run.",
      });
      return;
    }

    const threadId = await startThread(projectId, {
      branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
      worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
      envMode: activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
    });
    setThreadIntegrationState(threadId, true);
  }, [activeDraftThread, activeThread, projects, setThreadIntegrationState, startThread]);

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = threads
        .filter((thread) => thread.projectId === projectId)
        .toSorted(compareThreadsByCreatedAtDesc)[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [navigate, threads],
  );

  const addProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || isAddingProject) return;
      const api = readNativeApi();
      if (!api) return;

      setIsAddingProject(true);
      const finishAddingProject = () => {
        setIsAddingProject(false);
        setNewCwd("");
        setAddProjectError(null);
        setAddingProject(false);
      };

      const existing = projects.find((project) => project.cwd === cwd);
      if (existing) {
        focusMostRecentThreadForProject(existing.id);
        finishAddingProject();
        return;
      }

      const projectId = newProjectId();
      const createdAt = new Date().toISOString();
      const title = cwd.split(/[/\\]/).findLast(isNonEmptyString) ?? cwd;
      try {
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt,
        });
        await handleNewThread(projectId).catch(() => undefined);
      } catch (error) {
        const description =
          error instanceof Error ? error.message : "An error occurred while adding the project.";
        setIsAddingProject(false);
        if (shouldBrowseForProjectImmediately) {
          toastManager.add({
            type: "error",
            title: "Failed to add project",
            description,
          });
        } else {
          setAddProjectError(description);
        }
        return;
      }
      finishAddingProject();
    },
    [
      focusMostRecentThreadForProject,
      handleNewThread,
      isAddingProject,
      projects,
      shouldBrowseForProjectImmediately,
    ],
  );

  const handleAddProject = () => {
    void addProjectFromPath(newCwd);
  };

  const handlePickFolder = async () => {
    const api = readNativeApi();
    if (!api || isPickingFolder) return;
    setIsPickingFolder(true);
    let pickedPath: string | null = null;
    try {
      pickedPath = await api.dialogs.pickFolder();
    } catch {
      // Ignore picker failures and leave the current thread selection unchanged.
    }
    if (pickedPath) {
      await addProjectFromPath(pickedPath);
    } else if (!shouldBrowseForProjectImmediately) {
      addProjectInputRef.current?.focus();
    }
    setIsPickingFolder(false);
  };

  const handleStartAddProject = () => {
    setAddProjectError(null);
    if (shouldBrowseForProjectImmediately) {
      void handlePickFolder();
      return;
    }
    setAddingProject((prev) => !prev);
  };

  const cancelRename = useCallback(() => {
    setRenamingThreadId(null);
    renamingInputRef.current = null;
  }, []);

  const commitRename = useCallback(
    async (threadId: ThreadId, newTitle: string, originalTitle: string) => {
      const finishRename = () => {
        setRenamingThreadId((current) => {
          if (current !== threadId) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      const api = readNativeApi();
      if (!api) {
        finishRename();
        return;
      }
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId,
          title: trimmed,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
      finishRename();
    },
    [],
  );

  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );
      const thread = threads.find((t) => t.id === threadId);
      if (!thread) return;

      if (clicked === "rename") {
        setRenamingThreadId(threadId);
        setRenamingTitle(thread.title);
        renamingCommittedRef.current = false;
        return;
      }

      if (clicked === "mark-unread") {
        markThreadUnread(threadId);
        return;
      }
      if (clicked === "copy-thread-id") {
        try {
          await copyTextToClipboard(threadId);
          toastManager.add({
            type: "success",
            title: "Thread ID copied",
            description: threadId,
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy thread ID",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked !== "delete") return;
      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete thread "${thread.title}"?`,
            "This permanently clears conversation history for this thread.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }
      const threadProject = projects.find((project) => project.id === thread.projectId);
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(threads, threadId);
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        (await api.dialogs.confirm(
          [
            "This thread is the only one linked to this worktree:",
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            "Delete the worktree too?",
          ].join("\n"),
        ));

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      try {
        await api.terminal.close({
          threadId,
          deleteHistory: true,
        });
      } catch {
        // Terminal may already be closed
      }

      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = threads.find((entry) => entry.id !== threadId)?.id ?? null;
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      clearComposerDraftForThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(threadId);
      setThreadIntegrationState(threadId, false);
      if (shouldNavigateToFallback) {
        if (fallbackThreadId) {
          void navigate({
            to: "/$threadId",
            params: { threadId: fallbackThreadId },
            replace: true,
          });
        } else {
          void navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await removeWorktreeMutation.mutateAsync({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error removing worktree.";
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add({
          type: "error",
          title: "Thread deleted, but worktree removal failed",
          description: `Could not remove ${displayWorktreePath ?? orphanedWorktreePath}. ${message}`,
        });
      }
    },
    [
      appSettings.confirmThreadDelete,
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      markThreadUnread,
      navigate,
      projects,
      removeWorktreeMutation,
      routeThreadId,
      setThreadIntegrationState,
      threads,
    ],
  );

  const handleProjectContextMenu = useCallback(
    async (projectId: ProjectId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [{ id: "delete", label: "Delete", destructive: true }],
        position,
      );
      if (clicked !== "delete") return;

      const project = projects.find((entry) => entry.id === projectId);
      if (!project) return;

      const projectThreads = threads.filter((thread) => thread.projectId === projectId);
      if (projectThreads.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Project is not empty",
          description: "Delete all threads in this project before deleting it.",
        });
        return;
      }

      const confirmed = await api.dialogs.confirm(
        [`Delete project "${project.name}"?`, "This action cannot be undone."].join("\n"),
      );
      if (!confirmed) return;

      try {
        const projectDraftThread = getDraftThreadByProjectId(projectId);
        if (projectDraftThread) {
          clearComposerDraftForThread(projectDraftThread.threadId);
        }
        clearProjectDraftThreadId(projectId);
        await api.orchestration.dispatchCommand({
          type: "project.delete",
          commandId: newCommandId(),
          projectId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error deleting project.";
        console.error("Failed to remove project", { projectId, error });
        toastManager.add({
          type: "error",
          title: `Failed to delete "${project.name}"`,
          description: message,
        });
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadId,
      getDraftThreadByProjectId,
      projects,
      threads,
    ],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      const activeThread = routeThreadId
        ? threads.find((thread) => thread.id === routeThreadId)
        : undefined;
      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
      if (isChatNewLocalShortcut(event, keybindings)) {
        const projectId =
          activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id;
        if (!projectId) return;
        event.preventDefault();
        void handleNewThread(projectId);
        return;
      }

      if (!isChatNewShortcut(event, keybindings)) return;
      const projectId = activeThread?.projectId ?? activeDraftThread?.projectId ?? projects[0]?.id;
      if (!projectId) return;
      event.preventDefault();
      void handleNewThread(projectId, {
        branch: activeThread?.branch ?? activeDraftThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? activeDraftThread?.worktreePath ?? null,
        envMode: activeDraftThread?.envMode ?? (activeThread?.worktreePath ? "worktree" : "local"),
      });
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [getDraftThread, handleNewThread, keybindings, projects, routeThreadId, threads]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const showDesktopUpdateButton = isElectron && shouldShowDesktopUpdateButton(desktopUpdateState);

  const desktopUpdateTooltip = desktopUpdateState
    ? getDesktopUpdateButtonTooltip(desktopUpdateState)
    : "Update available";

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const desktopUpdateButtonInteractivityClasses = desktopUpdateButtonDisabled
    ? "cursor-not-allowed opacity-60"
    : "hover:bg-accent hover:text-foreground";
  const desktopUpdateButtonClasses =
    desktopUpdateState?.status === "downloaded"
      ? "text-emerald-500"
      : desktopUpdateState?.status === "downloading"
        ? "text-sky-400"
        : shouldHighlightDesktopUpdateError(desktopUpdateState)
          ? "text-rose-500 animate-pulse-soft"
          : "text-amber-500 animate-pulse-soft";
  const newThreadShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "chat.newLocal") ??
      shortcutLabelForCommand(keybindings, "chat.new"),
    [keybindings],
  );

  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: "Update downloaded",
              description: "Restart the app from the update button to install it.",
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not download update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start update download",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: actionError,
          });
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not install update",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        });
    }
  }, [desktopUpdateButtonAction, desktopUpdateButtonDisabled, desktopUpdateState]);

  const expandThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectId)) return current;
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectId: ProjectId) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }, []);

  const renderProjectCollectionSection = ({
    emptyLabel,
    items,
    showAddButton = false,
    title,
  }: {
    emptyLabel: string;
    items: ReadonlyArray<Project>;
    showAddButton?: boolean;
    title: string;
  }) => (
    <SidebarGroup className="px-1 py-1">
      <div className="mb-2 flex items-center justify-between px-2">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted-foreground/60">
          {title}
        </span>
        {showAddButton ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Add project"
                  aria-pressed={shouldShowProjectPathEntry}
                  className="inline-flex size-7 items-center justify-center rounded-full border border-transparent text-muted-foreground/65 transition-all duration-150 hover:border-border/60 hover:bg-accent/50 hover:text-foreground"
                  onClick={handleStartAddProject}
                />
              }
            >
              <PlusIcon
                className={`size-3.5 transition-transform duration-150 ${
                  shouldShowProjectPathEntry ? "rotate-45" : "rotate-0"
                }`}
              />
            </TooltipTrigger>
            <TooltipPopup side="right">Add project</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>

      {showAddButton && shouldShowProjectPathEntry && (
        <div className="mb-2 px-1">
          {isElectron && (
            <button
              type="button"
              className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-md border border-border bg-secondary py-1.5 text-xs text-foreground/80 transition-colors duration-150 hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void handlePickFolder()}
              disabled={isPickingFolder || isAddingProject}
            >
              <FolderIcon className="size-3.5" />
              {isPickingFolder ? "Picking folder..." : "Browse for folder"}
            </button>
          )}
          <div className="flex gap-1.5">
            <input
              ref={addProjectInputRef}
              className={`min-w-0 flex-1 rounded-md border bg-secondary px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none ${
                addProjectError
                  ? "border-red-500/70 focus:border-red-500"
                  : "border-border focus:border-ring"
              }`}
              placeholder="/path/to/project"
              value={newCwd}
              onChange={(event) => {
                setNewCwd(event.target.value);
                setAddProjectError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleAddProject();
                if (event.key === "Escape") {
                  setAddingProject(false);
                  setAddProjectError(null);
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
              onClick={handleAddProject}
              disabled={isAddingProject}
            >
              {isAddingProject ? "Adding..." : "Add"}
            </button>
          </div>
          {addProjectError && (
            <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">{addProjectError}</p>
          )}
          <div className="mt-1.5 px-0.5">
            <button
              type="button"
              className="text-[11px] text-muted-foreground/50 transition-colors hover:text-muted-foreground"
              onClick={() => {
                setAddingProject(false);
                setAddProjectError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <SidebarMenu>
        {items.map((project) => {
          const projectThreads = sortedThreadsByProjectId.get(project.id) ?? EMPTY_THREADS;
          const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
          const hasHiddenThreads = projectThreads.length > THREAD_PREVIEW_LIMIT;
          const visibleThreads =
            hasHiddenThreads && !isThreadListExpanded
              ? projectThreads.slice(0, THREAD_PREVIEW_LIMIT)
              : projectThreads;

          return (
            <Collapsible
              key={project.id}
              className="group/collapsible"
              open={project.expanded}
              onOpenChange={(open) => {
                if (open === project.expanded) return;
                toggleProject(project.id);
              }}
            >
              <SidebarMenuItem>
                <div className="group/project-header relative rounded-xl border border-transparent transition-colors duration-150 hover:border-border/60 hover:bg-accent/40">
                  <CollapsibleTrigger
                    render={
                      <SidebarMenuButton
                        size="sm"
                        className="gap-2.5 px-2.5 py-2 text-left hover:bg-transparent group-hover/project-header:text-sidebar-accent-foreground"
                      />
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      void handleProjectContextMenu(project.id, {
                        x: event.clientX,
                        y: event.clientY,
                      });
                    }}
                  >
                    <ChevronRightIcon
                      className={`size-3.5 shrink-0 text-muted-foreground/55 transition-transform duration-150 ${
                        project.expanded ? "rotate-90" : ""
                      }`}
                    />
                    <ProjectFavicon cwd={project.cwd} name={project.name} />
                    <span className="flex-1 truncate text-[12px] font-medium text-foreground/90">
                      {project.name}
                    </span>
                  </CollapsibleTrigger>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <SidebarMenuAction
                          render={
                            <button
                              type="button"
                              aria-label={`Create new thread in ${project.name}`}
                            />
                          }
                          showOnHover
                          className="top-1.5 right-1.5 size-6 rounded-full p-0 text-muted-foreground/65 hover:bg-background/85 hover:text-foreground"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleNewThread(project.id);
                          }}
                        >
                          <SquarePenIcon className="size-3.5" />
                        </SidebarMenuAction>
                      }
                    />
                    <TooltipPopup side="top">
                      {newThreadShortcutLabel
                        ? `New thread (${newThreadShortcutLabel})`
                        : "New thread"}
                    </TooltipPopup>
                  </Tooltip>
                </div>

                <CollapsibleContent>
                  <SidebarMenuSub className="mx-0.5 my-1 w-full translate-x-0 gap-0.5 border-none px-1 py-0">
                    {visibleThreads.map((thread) => {
                      const isActive = routeThreadId === thread.id;
                      const threadStatus = resolveThreadStatusPill({
                        thread,
                        hasPendingApprovals: pendingApprovalByThreadId.get(thread.id) === true,
                        hasPendingUserInput: pendingUserInputByThreadId.get(thread.id) === true,
                      });
                      const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
                      const terminalStatus = terminalStatusFromRunningIds(
                        selectThreadTerminalState(terminalStateByThreadId, thread.id)
                          .runningTerminalIds,
                      );

                      return (
                        <SidebarMenuSubItem key={thread.id} className="w-full">
                          <SidebarMenuSubButton
                            render={<div role="button" tabIndex={0} />}
                            size="sm"
                            isActive={isActive}
                            className={`h-[34px] w-full translate-x-0 cursor-default rounded-xl justify-start px-2.5 text-left transition-colors duration-150 hover:bg-accent/55 hover:text-foreground ${
                              isActive
                                ? "border border-border/70 bg-background/92 text-foreground font-medium shadow-xs/5"
                                : "border border-transparent text-muted-foreground/82"
                            }`}
                            onClick={() => {
                              void navigate({
                                to: "/$threadId",
                                params: { threadId: thread.id },
                              });
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              event.preventDefault();
                              void navigate({
                                to: "/$threadId",
                                params: { threadId: thread.id },
                              });
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              void handleThreadContextMenu(thread.id, {
                                x: event.clientX,
                                y: event.clientY,
                              });
                            }}
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                              {threadStatus && (
                                <span
                                  className={`inline-flex size-1.5 shrink-0 rounded-full ${threadStatus.dotClass} ${threadStatus.pulse ? "animate-pulse-soft" : ""}`}
                                />
                              )}
                              {prStatus && (
                                <Tooltip>
                                  <TooltipTrigger
                                    render={
                                      <button
                                        type="button"
                                        aria-label={prStatus.tooltip}
                                        className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                                        onClick={(event) => {
                                          openPrLink(event, prStatus.url);
                                        }}
                                      >
                                        <GitPullRequestIcon className="size-3" />
                                      </button>
                                    }
                                  />
                                  <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
                                </Tooltip>
                              )}
                              {renamingThreadId === thread.id ? (
                                <input
                                  ref={(el) => {
                                    if (el && renamingInputRef.current !== el) {
                                      renamingInputRef.current = el;
                                      el.focus();
                                      el.select();
                                    }
                                  }}
                                  className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-[12px] outline-none"
                                  value={renamingTitle}
                                  onChange={(e) => setRenamingTitle(e.target.value)}
                                  onKeyDown={(e) => {
                                    e.stopPropagation();
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      renamingCommittedRef.current = true;
                                      void commitRename(thread.id, renamingTitle, thread.title);
                                    } else if (e.key === "Escape") {
                                      e.preventDefault();
                                      renamingCommittedRef.current = true;
                                      cancelRename();
                                    }
                                  }}
                                  onBlur={() => {
                                    if (!renamingCommittedRef.current) {
                                      void commitRename(thread.id, renamingTitle, thread.title);
                                    }
                                  }}
                                  onClick={(e) => e.stopPropagation()}
                                />
                              ) : (
                                <span className="min-w-0 flex-1 truncate text-[12px]">
                                  {thread.title}
                                </span>
                              )}
                            </div>
                            <div className="ml-auto flex shrink-0 items-center gap-2">
                              {threadStatus && (
                                <span
                                  className={`hidden max-w-[7rem] truncate text-[10px] font-medium ${threadStatus.colorClass} lg:inline`}
                                  title={threadStatus.label}
                                >
                                  {threadStatus.label}
                                </span>
                              )}
                              {terminalStatus && (
                                <span
                                  role="img"
                                  aria-label={terminalStatus.label}
                                  title={terminalStatus.label}
                                  className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
                                >
                                  <TerminalIcon
                                    className={`size-3 ${terminalStatus.pulse ? "animate-pulse-soft" : ""}`}
                                  />
                                </span>
                              )}
                              <span
                                className={`text-[10px] tabular-nums ${
                                  isActive ? "text-foreground/52" : "text-muted-foreground/42"
                                }`}
                              >
                                {formatRelativeTime(thread.createdAt)}
                              </span>
                            </div>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      );
                    })}

                    {hasHiddenThreads && !isThreadListExpanded && (
                      <SidebarMenuSubItem className="w-full">
                        <SidebarMenuSubButton
                          render={<button type="button" />}
                          size="sm"
                          className="h-7 w-full translate-x-0 rounded-xl justify-start px-2.5 text-left text-[10px] text-muted-foreground/60 hover:bg-accent/40 hover:text-muted-foreground/80"
                          onClick={() => {
                            expandThreadListForProject(project.id);
                          }}
                        >
                          <span>Show more</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    )}
                    {hasHiddenThreads && isThreadListExpanded && (
                      <SidebarMenuSubItem className="w-full">
                        <SidebarMenuSubButton
                          render={<button type="button" />}
                          size="sm"
                          className="h-7 w-full translate-x-0 rounded-xl justify-start px-2.5 text-left text-[10px] text-muted-foreground/60 hover:bg-accent/40 hover:text-muted-foreground/80"
                          onClick={() => {
                            collapseThreadListForProject(project.id);
                          }}
                        >
                          <span>Show less</span>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    )}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          );
        })}
      </SidebarMenu>

      {items.length === 0 && !showAddButton && (
        <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">{emptyLabel}</div>
      )}
      {items.length === 0 && showAddButton && !shouldShowProjectPathEntry && (
        <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">{emptyLabel}</div>
      )}
    </SidebarGroup>
  );

  const renderIntegrationSection = () => (
    <SidebarGroup className="px-1 py-1">
      <div className="mb-2 flex items-center justify-between px-2">
        <span className="text-[11px] font-medium tracking-[0.04em] text-muted-foreground/60">
          Integrations
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="New integration thread"
                className="inline-flex size-7 items-center justify-center rounded-full border border-transparent text-muted-foreground/65 transition-all duration-150 hover:border-border/60 hover:bg-accent/50 hover:text-foreground"
                onClick={() => {
                  void handleNewIntegrationThread();
                }}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="right">New integration thread</TooltipPopup>
        </Tooltip>
      </div>

      {integrationThreads.length > 0 ? (
        <SidebarMenu>
          {integrationThreads.map((thread) => {
            const isActive = routeThreadId === thread.id;
            const threadStatus = resolveThreadStatusPill({
              thread,
              hasPendingApprovals: pendingApprovalByThreadId.get(thread.id) === true,
              hasPendingUserInput: pendingUserInputByThreadId.get(thread.id) === true,
            });
            const prStatus = prStatusIndicator(prByThreadId.get(thread.id) ?? null);
            const terminalStatus = terminalStatusFromRunningIds(
              selectThreadTerminalState(terminalStateByThreadId, thread.id).runningTerminalIds,
            );

            return (
              <SidebarMenuItem key={thread.id}>
                <SidebarMenuButton
                  render={<div role="button" tabIndex={0} />}
                  size="sm"
                  isActive={isActive}
                  className={`h-[34px] w-full cursor-default rounded-xl justify-start px-2.5 text-left transition-colors duration-150 hover:bg-accent/55 hover:text-foreground ${
                    isActive
                      ? "border border-border/70 bg-background/92 text-foreground font-medium shadow-xs/5"
                      : "border border-transparent text-muted-foreground/82"
                  }`}
                  onClick={() => {
                    void navigate({
                      to: "/$threadId",
                      params: { threadId: thread.id },
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    void navigate({
                      to: "/$threadId",
                      params: { threadId: thread.id },
                    });
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void handleThreadContextMenu(thread.id, {
                      x: event.clientX,
                      y: event.clientY,
                    });
                  }}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <ZapIcon className="size-3.5 shrink-0 text-amber-400/85" />
                    {threadStatus && (
                      <span
                        className={`inline-flex size-1.5 shrink-0 rounded-full ${threadStatus.dotClass} ${threadStatus.pulse ? "animate-pulse-soft" : ""}`}
                      />
                    )}
                    {prStatus && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={prStatus.tooltip}
                              className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                              onClick={(event) => {
                                openPrLink(event, prStatus.url);
                              }}
                            >
                              <GitPullRequestIcon className="size-3" />
                            </button>
                          }
                        />
                        <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
                      </Tooltip>
                    )}
                    {renamingThreadId === thread.id ? (
                      <input
                        ref={(el) => {
                          if (el && renamingInputRef.current !== el) {
                            renamingInputRef.current = el;
                            el.focus();
                            el.select();
                          }
                        }}
                        className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-[12px] outline-none"
                        value={renamingTitle}
                        onChange={(e) => setRenamingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            e.preventDefault();
                            renamingCommittedRef.current = true;
                            void commitRename(thread.id, renamingTitle, thread.title);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            renamingCommittedRef.current = true;
                            cancelRename();
                          }
                        }}
                        onBlur={() => {
                          if (!renamingCommittedRef.current) {
                            void commitRename(thread.id, renamingTitle, thread.title);
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-[12px]">{thread.title}</span>
                    )}
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    {threadStatus && (
                      <span
                        className={`hidden max-w-[7rem] truncate text-[10px] font-medium ${threadStatus.colorClass} lg:inline`}
                        title={threadStatus.label}
                      >
                        {threadStatus.label}
                      </span>
                    )}
                    {terminalStatus && (
                      <span
                        role="img"
                        aria-label={terminalStatus.label}
                        title={terminalStatus.label}
                        className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
                      >
                        <TerminalIcon
                          className={`size-3 ${terminalStatus.pulse ? "animate-pulse-soft" : ""}`}
                        />
                      </span>
                    )}
                    <span
                      className={`text-[10px] tabular-nums ${
                        isActive ? "text-foreground/52" : "text-muted-foreground/42"
                      }`}
                    >
                      {formatRelativeTime(thread.createdAt)}
                    </span>
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      ) : projects.length > 0 ? (
        <div className="px-2 pt-3 pb-1 text-center text-xs text-muted-foreground/60">
          <p>No integrations yet</p>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-border/70 px-3 py-1 text-[11px] font-medium text-foreground/82 transition-colors hover:bg-accent/50 hover:text-foreground"
            onClick={() => {
              void handleNewIntegrationThread();
            }}
          >
            <PlusIcon className="size-3" />
            New thread
          </button>
        </div>
      ) : (
        <div className="px-2 pt-3 pb-1 text-center text-xs text-muted-foreground/60">
          Add a project first to create integration threads
        </div>
      )}
    </SidebarGroup>
  );

  const wordmark = (
    <div className="flex min-w-0 items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <OciWordmark className="h-3.5 text-foreground/88" />
        <span className="rounded-full border border-border/70 bg-background/70 px-1.5 py-0.5 text-[8px] font-medium uppercase tracking-[0.18em] text-muted-foreground/70">
          {APP_STAGE_LABEL}
        </span>
      </div>
    </div>
  );

  return (
    <>
      {isElectron ? (
        <>
          <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 border-b border-border/70 px-4 py-0 pl-[90px]">
            {wordmark}
            {showDesktopUpdateButton && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={desktopUpdateTooltip}
                      aria-disabled={desktopUpdateButtonDisabled || undefined}
                      disabled={desktopUpdateButtonDisabled}
                      className={`inline-flex size-8 items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-all duration-150 hover:scale-105 ${desktopUpdateButtonInteractivityClasses} ${desktopUpdateButtonClasses}`}
                      onClick={handleDesktopUpdateButtonClick}
                    >
                      <RocketIcon className="size-3.5" />
                    </button>
                  }
                />
                <TooltipPopup side="bottom">{desktopUpdateTooltip}</TooltipPopup>
              </Tooltip>
            )}
          </SidebarHeader>
        </>
      ) : (
        <SidebarHeader className="gap-3 border-b border-border/70 px-3 py-3 sm:gap-2.5 sm:px-4">
          {wordmark}
        </SidebarHeader>
      )}

      <SidebarContent className="gap-0 px-2 py-2">
        {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
          <SidebarGroup className="px-2 pt-2 pb-0">
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/8">
              <TriangleAlertIcon />
              <AlertTitle>Intel build on Apple Silicon</AlertTitle>
              <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
              {desktopUpdateButtonAction !== "none" ? (
                <AlertAction>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={desktopUpdateButtonDisabled}
                    onClick={handleDesktopUpdateButtonClick}
                  >
                    {desktopUpdateButtonAction === "download"
                      ? "Download ARM build"
                      : "Install ARM build"}
                  </Button>
                </AlertAction>
              ) : null}
            </Alert>
          </SidebarGroup>
        ) : null}
        {renderIntegrationSection()}
        {renderProjectCollectionSection({
          title: "Projects",
          items: projects,
          showAddButton: true,
          emptyLabel: "No projects yet",
        })}
      </SidebarContent>

      <div className="mx-3 h-px bg-border/70" />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            {isOnSettings ? (
              <SidebarMenuButton
                size="sm"
                className="gap-2 rounded-xl px-2.5 py-2 text-muted-foreground/72 hover:bg-accent/45 hover:text-foreground"
                onClick={() => window.history.back()}
              >
                <ArrowLeftIcon className="size-3.5" />
                <span className="text-[12px]">Back</span>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                size="sm"
                className="gap-2 rounded-xl px-2.5 py-2 text-muted-foreground/72 hover:bg-accent/45 hover:text-foreground"
                onClick={() => void navigate({ to: "/settings" })}
              >
                <SettingsIcon className="size-3.5" />
                <span className="text-[12px]">Settings</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
