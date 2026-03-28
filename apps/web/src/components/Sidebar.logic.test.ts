import { ProjectId, ThreadId } from "@ocicode/contracts";
import { describe, expect, it } from "vitest";

import {
  getFallbackThreadIdAfterDelete,
  hasUnseenCompletion,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  sortProjectsForSidebar,
  sortThreadsForSidebar,
} from "./Sidebar.logic";

function makeLatestTurn(overrides?: {
  completedAt?: string | null;
  startedAt?: string | null;
}): Parameters<typeof hasUnseenCompletion>[0]["latestTurn"] {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: overrides?.startedAt ?? "2026-03-09T10:00:00.000Z",
    completedAt: overrides?.completedAt ?? "2026-03-09T10:05:00.000Z",
  };
}

describe("hasUnseenCompletion", () => {
  it("returns true when a thread completed after its last visit", () => {
    expect(
      hasUnseenCompletion({
        interactionMode: "default",
        latestTurn: makeLatestTurn(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        proposedPlans: [],
        session: null,
      }),
    ).toBe(true);
  });
});

describe("resolveThreadStatusPill", () => {
  const baseThread = {
    interactionMode: "plan" as const,
    latestTurn: null,
    lastVisitedAt: undefined,
    proposedPlans: [],
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus: "running" as const,
    },
  };

  it("shows pending approval before all other statuses", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Pending Approval", pulse: false });
  });

  it("shows awaiting input when plan mode is blocked on user answers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: true,
      }),
    ).toMatchObject({ label: "Awaiting Input", pulse: false });
  });

  it("falls back to working when the thread is actively running without blockers", () => {
    expect(
      resolveThreadStatusPill({
        thread: baseThread,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Working", pulse: true });
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          latestTurn: makeLatestTurn(),
          proposedPlans: [
            {
              id: "plan-1" as never,
              turnId: "turn-1" as never,
              createdAt: "2026-03-09T10:00:00.000Z",
              updatedAt: "2026-03-09T10:05:00.000Z",
              planMarkdown: "# Plan",
            },
          ],
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Plan Ready", pulse: false });
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusPill({
        thread: {
          ...baseThread,
          interactionMode: "default",
          latestTurn: makeLatestTurn(),
          lastVisitedAt: "2026-03-09T10:04:00.000Z",
          session: {
            ...baseThread.session,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toMatchObject({ label: "Completed", pulse: false });
  });
});

describe("resolveThreadRowClassName", () => {
  it("uses the flatter upstream hover treatment for inactive rows", () => {
    const className = resolveThreadRowClassName({ isActive: false, isSelected: false });

    expect(className).toContain("hover:bg-accent");
    expect(className).not.toContain("rounded-xl");
    expect(className).not.toContain("border ");
  });

  it("keeps selected rows on the primary surface", () => {
    expect(resolveThreadRowClassName({ isActive: false, isSelected: true })).toContain(
      "bg-primary/15",
    );
    expect(resolveThreadRowClassName({ isActive: true, isSelected: true })).toContain(
      "bg-primary/22",
    );
  });
});

describe("sidebar sorting", () => {
  it("sorts threads by latest user activity by default", () => {
    const threads = [
      {
        id: ThreadId.makeUnsafe("thread-a"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:00:00.000Z",
        updatedAt: "2026-03-09T10:00:00.000Z",
        messages: [
          {
            id: "message-a" as never,
            role: "user" as const,
            text: "first",
            createdAt: "2026-03-09T10:00:00.000Z",
            streaming: false,
          },
        ],
      },
      {
        id: ThreadId.makeUnsafe("thread-b"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T11:00:00.000Z",
        updatedAt: "2026-03-09T11:00:00.000Z",
        messages: [
          {
            id: "message-b" as never,
            role: "user" as const,
            text: "second",
            createdAt: "2026-03-09T11:00:00.000Z",
            streaming: false,
          },
        ],
      },
    ];

    expect(sortThreadsForSidebar(threads, "updated_at").map((thread) => thread.id)).toEqual([
      "thread-b",
      "thread-a",
    ]);
  });

  it("preserves manual project order", () => {
    const projects = [
      {
        id: ProjectId.makeUnsafe("project-a"),
        name: "Project A",
        createdAt: "2026-03-09T10:00:00.000Z",
      },
      {
        id: ProjectId.makeUnsafe("project-b"),
        name: "Project B",
        createdAt: "2026-03-09T11:00:00.000Z",
      },
    ];

    expect(sortProjectsForSidebar(projects, [], "manual").map((project) => project.id)).toEqual([
      "project-a",
      "project-b",
    ]);
  });

  it("uses the selected sort order when resolving the next thread after delete", () => {
    const threads = [
      {
        id: ThreadId.makeUnsafe("thread-a"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T10:00:00.000Z",
        updatedAt: "2026-03-09T12:00:00.000Z",
        messages: [],
      },
      {
        id: ThreadId.makeUnsafe("thread-b"),
        projectId: ProjectId.makeUnsafe("project-1"),
        createdAt: "2026-03-09T11:00:00.000Z",
        updatedAt: "2026-03-09T11:00:00.000Z",
        messages: [],
      },
    ];

    expect(
      getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: ThreadId.makeUnsafe("thread-a"),
        sortOrder: "created_at",
      }),
    ).toBe(ThreadId.makeUnsafe("thread-b"));
  });
});
