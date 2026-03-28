import {
  ArrowLeftIcon,
  ArrowUpDownIcon,
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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  DndContext,
  type CollisionDetection,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
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
import {
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
  useAppSettings,
} from "../appSettings";
import { isElectron } from "../env";
import { APP_STAGE_LABEL } from "../branding";
import {
  isLinuxPlatform,
  isMacPlatform,
  newCommandId,
  newProjectId,
  newThreadId,
} from "../lib/utils";
import { cn } from "../lib/utils";
import { useStore } from "../store";
import { isChatNewLocalShortcut, isChatNewShortcut, shortcutLabelForCommand } from "../keybindings";
import { derivePendingApprovals, derivePendingUserInputs } from "../session-logic";
import { gitRemoveWorktreeMutationOptions, gitStatusQueryOptions } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { formatRelativeTime } from "../timestampFormat";
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
import { Menu, MenuGroup, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
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
import {
  getFallbackThreadIdAfterDelete,
  getVisibleThreadsForProject,
  resolveProjectStatusIndicator,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";
import type { Project, Thread } from "../types";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_THREADS: Thread[] = [];
const THREAD_PREVIEW_LIMIT = 6;
const INTEGRATION_THREAD_IDS_STORAGE_KEY = makeStorageKey("integration-thread-ids:v1");
const SIDEBAR_PROJECT_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
  manual: "Manual",
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  updated_at: "Last user message",
  created_at: "Created at",
};

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === "undefined" || navigator.clipboard?.writeText === undefined) {
    throw new Error("Clipboard API unavailable.");
  }
  await navigator.clipboard.writeText(text);
}

function formatRelativeTimeLabel(iso: string): string {
  const relative = formatRelativeTime(iso);
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
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
    window.localStorage.setItem(INTEGRATION_THREAD_IDS_STORAGE_KEY, JSON.stringify([...threadIds]));
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

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground" />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">Sidebar sorting</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-44">
        <MenuGroup>
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Sort projects</div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_PROJECT_SORT_LABELS) as Array<
                [SidebarProjectSortOrder, string]
              >
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
            Sort threads
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(SIDEBAR_THREAD_SORT_LABELS) as Array<[SidebarThreadSortOrder, string]>
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: ProjectId;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn(
        "group/menu-item relative",
        isDragging && "z-20 opacity-80",
        isOver && !isDragging && "ring-1 ring-primary/40",
      )}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

export default function Sidebar() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const markThreadUnread = useStore((store) => store.markThreadUnread);
  const toggleProject = useStore((store) => store.toggleProject);
  const reorderProjects = useStore((store) => store.reorderProjects);
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
  const { settings: appSettings, updateSettings: appSettingsUpdateSettings } = useAppSettings();
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
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [integrationThreadIds, setIntegrationThreadIds] = useState<ReadonlySet<ThreadId>>(() =>
    readPersistedIntegrationThreadIds(),
  );
  const selectedThreadIds = useThreadSelectionStore((store) => store.selectedThreadIds);
  const toggleThreadSelection = useThreadSelectionStore((store) => store.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((store) => store.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((store) => store.clearSelection);
  const removeFromSelection = useThreadSelectionStore((store) => store.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((store) => store.setAnchor);
  const isLinuxDesktop = isElectron && isLinuxPlatform(navigator.platform);
  const shouldBrowseForProjectImmediately = isElectron && !isLinuxDesktop;
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
  const sortedProjects = useMemo(
    () =>
      sortProjectsForSidebar(
        projects,
        threads.filter((thread) => !integrationThreadIds.has(thread.id)),
        appSettings.sidebarProjectSortOrder,
      ),
    [appSettings.sidebarProjectSortOrder, integrationThreadIds, projects, threads],
  );
  const sortedThreadsByProjectId = useMemo(() => {
    const threadsByProjectId = new Map<ProjectId, Thread[]>();
    for (const project of sortedProjects) {
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
      const sortedThreads = sortThreadsForSidebar(
        projectThreads,
        appSettings.sidebarThreadSortOrder,
      );
      projectThreads.splice(0, projectThreads.length, ...sortedThreads);
    }
    return threadsByProjectId;
  }, [appSettings.sidebarThreadSortOrder, integrationThreadIds, sortedProjects, threads]);
  const integrationThreads = useMemo(
    () =>
      sortThreadsForSidebar(
        threads.filter((thread) => integrationThreadIds.has(thread.id)),
        appSettings.sidebarThreadSortOrder,
      ),
    [appSettings.sidebarThreadSortOrder, integrationThreadIds, threads],
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
          envMode: options?.envMode ?? appSettings.defaultThreadEnvMode,
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
      appSettings.defaultThreadEnvMode,
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
      envMode:
        activeDraftThread?.envMode ??
        (activeThread?.worktreePath ? "worktree" : appSettings.defaultThreadEnvMode),
    });
    setThreadIntegrationState(threadId, true);
  }, [
    activeDraftThread,
    activeThread,
    appSettings.defaultThreadEnvMode,
    projects,
    setThreadIntegrationState,
    startThread,
  ]);

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = sortThreadsForSidebar(
        threads.filter((thread) => thread.projectId === projectId),
        appSettings.sidebarThreadSortOrder,
      )[0];
      if (!latestThread) return;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
    },
    [appSettings.sidebarThreadSortOrder, navigate, threads],
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

  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      opts: { deletedThreadIds?: ReadonlySet<ThreadId> } = {},
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;

      const threadProject = projects.find((project) => project.id === thread.projectId);
      const deletedIds = opts.deletedThreadIds;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((entry) => entry.id === threadId || !deletedIds.has(entry.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(survivingThreads, threadId);
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
        await api.terminal.close({ threadId, deleteHistory: true });
      } catch {
        // Terminal may already be closed.
      }

      const shouldNavigateToFallback = routeThreadId === threadId;
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadId,
        sortOrder: appSettings.sidebarThreadSortOrder,
        ...(deletedIds ? { deletedThreadIds: deletedIds } : {}),
      });
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId,
      });
      clearComposerDraftForThread(threadId);
      clearProjectDraftThreadById(thread.projectId, thread.id);
      clearTerminalState(threadId);
      removeFromSelection([threadId]);
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
      appSettings.sidebarThreadSortOrder,
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTerminalState,
      navigate,
      projects,
      removeFromSelection,
      removeWorktreeMutation,
      routeThreadId,
      setThreadIntegrationState,
      threads,
    ],
  );

  const handleThreadContextMenu = useCallback(
    async (threadId: ThreadId, position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const thread = threads.find((entry) => entry.id === threadId);
      if (!thread) return;
      const threadWorkspacePath =
        thread.worktreePath ?? projectCwdById.get(thread.projectId) ?? null;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename thread" },
          { id: "mark-unread", label: "Mark unread" },
          { id: "copy-path", label: "Copy Path" },
          { id: "copy-thread-id", label: "Copy Thread ID" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

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

      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add({
            type: "error",
            title: "Path unavailable",
            description: "This thread does not have a workspace path to copy.",
          });
          return;
        }
        try {
          await copyTextToClipboard(threadWorkspacePath);
          toastManager.add({
            type: "success",
            title: "Path copied",
            description: threadWorkspacePath,
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
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

      if (clicked !== "delete") {
        return;
      }

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

      await deleteThread(threadId);
    },
    [appSettings.confirmThreadDelete, deleteThread, markThreadUnread, projectCwdById, threads],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readNativeApi();
      if (!api) return;
      const ids = [...selectedThreadIds];
      if (ids.length === 0) return;

      const clicked = await api.contextMenu.show(
        [
          { id: "mark-unread", label: `Mark unread (${ids.length})` },
          { id: "delete", label: `Delete (${ids.length})`, destructive: true },
        ],
        position,
      );

      if (clicked === "mark-unread") {
        for (const id of ids) {
          markThreadUnread(id);
        }
        clearSelection();
        return;
      }

      if (clicked !== "delete") {
        return;
      }

      if (appSettings.confirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${ids.length} thread${ids.length === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      const deletedIds = new Set<ThreadId>(ids);
      for (const id of ids) {
        await deleteThread(id, { deletedThreadIds: deletedIds });
      }
      removeFromSelection(ids);
    },
    [
      appSettings.confirmThreadDelete,
      clearSelection,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
      selectedThreadIds,
    ],
  );

  const handleThreadClick = useCallback(
    (event: MouseEvent, threadId: ThreadId, orderedProjectThreadIds: readonly ThreadId[]) => {
      const isModClick = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadId);
        return;
      }

      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadId, orderedProjectThreadIds);
        return;
      }

      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadId);
      void navigate({
        to: "/$threadId",
        params: { threadId },
      });
    },
    [
      clearSelection,
      navigate,
      rangeSelectTo,
      selectedThreadIds,
      setSelectionAnchor,
      toggleThreadSelection,
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

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }
    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const activeProject = projects.find((project) => project.id === active.id);
      const overProject = projects.find((project) => project.id === over.id);
      if (!activeProject || !overProject) {
        return;
      }
      reorderProjects(activeProject.id, overProject.id);
    },
    [appSettings.sidebarProjectSortOrder, projects, reorderProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (appSettings.sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [appSettings.sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const handleProjectTitlePointerDownCapture = useCallback(() => {
    suppressProjectClickAfterDragRef.current = false;
  }, []);

  const handleProjectTitleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (selectedThreadIds.size > 0) {
        clearSelection();
      }
      toggleProject(projectId);
    },
    [clearSelection, selectedThreadIds, toggleProject],
  );

  const handleProjectTitleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, projectId: ProjectId) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(projectId);
    },
    [toggleProject],
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
        envMode:
          activeDraftThread?.envMode ??
          (activeThread?.worktreePath ? "worktree" : appSettings.defaultThreadEnvMode),
      });
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    appSettings.defaultThreadEnvMode,
    getDraftThread,
    handleNewThread,
    keybindings,
    projects,
    routeThreadId,
    threads,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      clearSelection();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelection]);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (selectedThreadIds.size === 0) {
        return;
      }
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) {
        return;
      }
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [clearSelection, selectedThreadIds]);

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
  }) => {
    const isManualProjectSorting =
      showAddButton && appSettings.sidebarProjectSortOrder === "manual";

    const renderProjectItem = (project: Project, dragHandleProps?: SortableProjectHandleProps) => {
      const projectThreads = sortedThreadsByProjectId.get(project.id) ?? EMPTY_THREADS;
      const activeThreadId = routeThreadId ?? undefined;
      const isThreadListExpanded = expandedThreadListsByProject.has(project.id);
      const pinnedCollapsedThread =
        !project.expanded && activeThreadId
          ? (projectThreads.find((thread) => thread.id === activeThreadId) ?? null)
          : null;
      const shouldShowThreadPanel = project.expanded || pinnedCollapsedThread !== null;
      const projectStatus = resolveProjectStatusIndicator(
        projectThreads.map((thread) =>
          resolveThreadStatusPill({
            thread,
            hasPendingApprovals: pendingApprovalByThreadId.get(thread.id) === true,
            hasPendingUserInput: pendingUserInputByThreadId.get(thread.id) === true,
          }),
        ),
      );
      const { hasHiddenThreads, visibleThreads } = getVisibleThreadsForProject({
        threads: projectThreads,
        activeThreadId,
        isThreadListExpanded,
        previewLimit: THREAD_PREVIEW_LIMIT,
      });
      const renderedThreads = pinnedCollapsedThread ? [pinnedCollapsedThread] : visibleThreads;
      const orderedProjectThreadIds = projectThreads.map((thread) => thread.id);

      return (
        <Collapsible key={project.id} className="group/collapsible" open={shouldShowThreadPanel}>
          <div className="group/project-header relative">
            <CollapsibleTrigger
              render={
                <SidebarMenuButton
                  ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
                  size="sm"
                  className={cn(
                    "gap-2 px-2 py-1.5 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground",
                    isManualProjectSorting
                      ? "cursor-grab active:cursor-grabbing"
                      : "cursor-pointer",
                  )}
                  {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
                  {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
                />
              }
              onPointerDownCapture={handleProjectTitlePointerDownCapture}
              onClick={(event) => handleProjectTitleClick(event, project.id)}
              onKeyDown={(event) => handleProjectTitleKeyDown(event, project.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                void handleProjectContextMenu(project.id, {
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              {!project.expanded && projectStatus ? (
                <span
                  aria-hidden="true"
                  title={projectStatus.label}
                  className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
                >
                  <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/project-header:opacity-0">
                    <span
                      className={`size-[9px] rounded-full ${projectStatus.dotClass} ${
                        projectStatus.pulse ? "animate-pulse-soft" : ""
                      }`}
                    />
                  </span>
                  <ChevronRightIcon className="absolute inset-0 m-auto size-3.5 text-muted-foreground/70 opacity-0 transition-opacity duration-150 group-hover/project-header:opacity-100" />
                </span>
              ) : (
                <ChevronRightIcon
                  className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${
                    project.expanded ? "rotate-90" : ""
                  }`}
                />
              )}
              <ProjectFavicon cwd={project.cwd} name={project.name} />
              <span className="flex-1 truncate text-xs font-medium text-foreground/90">
                {project.name}
              </span>
            </CollapsibleTrigger>
            <Tooltip>
              <TooltipTrigger
                render={
                  <SidebarMenuAction
                    render={
                      <button type="button" aria-label={`Create new thread in ${project.name}`} />
                    }
                    showOnHover
                    className="top-1 right-1 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
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
                {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
              </TooltipPopup>
            </Tooltip>
          </div>

          <CollapsibleContent>
            <SidebarMenuSub className="mx-0.5 my-1 w-full translate-x-0 gap-0.5 border-none px-1 py-0">
              {renderedThreads.map((thread) => {
                const isActive = routeThreadId === thread.id;
                const isSelected = selectedThreadIds.has(thread.id);
                const isHighlighted = isActive || isSelected;
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
                  <SidebarMenuSubItem key={thread.id} className="w-full" data-thread-item>
                    <SidebarMenuSubButton
                      render={<div role="button" tabIndex={0} />}
                      size="sm"
                      isActive={isActive}
                      className={resolveThreadRowClassName({
                        isActive,
                        isSelected,
                      })}
                      onClick={(event) => {
                        handleThreadClick(event, thread.id, orderedProjectThreadIds);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        if (selectedThreadIds.size > 0) {
                          clearSelection();
                        }
                        setSelectionAnchor(thread.id);
                        void navigate({
                          to: "/$threadId",
                          params: { threadId: thread.id },
                        });
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        if (selectedThreadIds.size > 0 && selectedThreadIds.has(thread.id)) {
                          void handleMultiSelectContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                          });
                        } else {
                          if (selectedThreadIds.size > 0) {
                            clearSelection();
                          }
                          void handleThreadContextMenu(thread.id, {
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }
                      }}
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
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
                            ref={(element) => {
                              if (element && renamingInputRef.current !== element) {
                                renamingInputRef.current = element;
                                element.focus();
                                element.select();
                              }
                            }}
                            className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-[12px] outline-none"
                            value={renamingTitle}
                            onChange={(event) => setRenamingTitle(event.target.value)}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") {
                                event.preventDefault();
                                renamingCommittedRef.current = true;
                                void commitRename(thread.id, renamingTitle, thread.title);
                              } else if (event.key === "Escape") {
                                event.preventDefault();
                                renamingCommittedRef.current = true;
                                cancelRename();
                              }
                            }}
                            onBlur={() => {
                              if (!renamingCommittedRef.current) {
                                void commitRename(thread.id, renamingTitle, thread.title);
                              }
                            }}
                            onClick={(event) => event.stopPropagation()}
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
                            isHighlighted
                              ? "text-foreground/72 dark:text-foreground/82"
                              : "text-muted-foreground/40"
                          }`}
                        >
                          {formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt)}
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
                    data-thread-selection-safe
                    size="sm"
                    className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
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
                    data-thread-selection-safe
                    size="sm"
                    className="h-6 w-full translate-x-0 justify-start px-2 text-left text-[10px] text-muted-foreground/60 hover:bg-accent hover:text-muted-foreground/80"
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
        </Collapsible>
      );
    };

    return (
      <SidebarGroup className="px-1 py-1">
        <div className="mb-2 flex items-center justify-between px-2">
          <span className="text-[11px] font-medium tracking-[0.04em] text-muted-foreground/60">
            {title}
          </span>
          <div className="flex items-center gap-1">
            {showAddButton ? (
              <ProjectSortMenu
                projectSortOrder={appSettings.sidebarProjectSortOrder}
                threadSortOrder={appSettings.sidebarThreadSortOrder}
                onProjectSortOrderChange={(sortOrder) => {
                  appSettingsUpdateSettings({ sidebarProjectSortOrder: sortOrder });
                }}
                onThreadSortOrderChange={(sortOrder) => {
                  appSettingsUpdateSettings({ sidebarThreadSortOrder: sortOrder });
                }}
              />
            ) : null}
            {showAddButton ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Add project"
                      aria-pressed={shouldShowProjectPathEntry}
                      className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
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
              <p className="mt-1 px-0.5 text-[11px] leading-tight text-red-400">
                {addProjectError}
              </p>
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

        {isManualProjectSorting ? (
          <DndContext
            sensors={projectDnDSensors}
            collisionDetection={projectCollisionDetection}
            modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
            onDragStart={handleProjectDragStart}
            onDragEnd={handleProjectDragEnd}
            onDragCancel={handleProjectDragCancel}
          >
            <SidebarMenu>
              <SortableContext
                items={items.map((project) => project.id)}
                strategy={verticalListSortingStrategy}
              >
                {items.map((project) => (
                  <SortableProjectItem key={project.id} projectId={project.id}>
                    {(dragHandleProps) => renderProjectItem(project, dragHandleProps)}
                  </SortableProjectItem>
                ))}
              </SortableContext>
            </SidebarMenu>
          </DndContext>
        ) : (
          <SidebarMenu>
            {items.map((project) => (
              <SidebarMenuItem key={project.id}>{renderProjectItem(project)}</SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}

        {items.length === 0 && !showAddButton && (
          <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">{emptyLabel}</div>
        )}
        {items.length === 0 && showAddButton && !shouldShowProjectPathEntry && (
          <div className="px-2 pt-4 text-center text-xs text-muted-foreground/60">{emptyLabel}</div>
        )}
      </SidebarGroup>
    );
  };

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
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
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
                  className={resolveThreadRowClassName({
                    isActive,
                    isSelected: false,
                  })}
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
                      {formatRelativeTimeLabel(thread.updatedAt ?? thread.createdAt)}
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
            className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
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
          <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
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
        <SidebarHeader className="gap-3 px-3 py-3 sm:gap-2.5 sm:px-4">{wordmark}</SidebarHeader>
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
          items: sortedProjects,
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
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() => window.history.back()}
              >
                <ArrowLeftIcon className="size-3.5" />
                <span className="text-xs">Back</span>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                size="sm"
                className="gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
                onClick={() => void navigate({ to: "/settings" })}
              >
                <SettingsIcon className="size-3.5" />
                <span className="text-xs">Settings</span>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
