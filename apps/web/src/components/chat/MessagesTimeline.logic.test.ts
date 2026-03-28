import { describe, expect, it } from "vitest";

import { computeMessageDurationStart, normalizeCompactToolLabel } from "./MessagesTimeline.logic";

describe("computeMessageDurationStart", () => {
  it("anchors assistant duration to the preceding user message", () => {
    const starts = computeMessageDurationStart([
      {
        id: "user-1",
        role: "user",
        createdAt: "2026-03-27T10:00:00.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: "2026-03-27T10:00:03.000Z",
        completedAt: "2026-03-27T10:00:07.000Z",
      },
    ]);

    expect(starts.get("user-1")).toBe("2026-03-27T10:00:00.000Z");
    expect(starts.get("assistant-1")).toBe("2026-03-27T10:00:00.000Z");
  });

  it("resets the boundary after a completed assistant response", () => {
    const starts = computeMessageDurationStart([
      {
        id: "user-1",
        role: "user",
        createdAt: "2026-03-27T10:00:00.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: "2026-03-27T10:00:03.000Z",
        completedAt: "2026-03-27T10:00:07.000Z",
      },
      {
        id: "assistant-2",
        role: "assistant",
        createdAt: "2026-03-27T10:00:09.000Z",
      },
    ]);

    expect(starts.get("assistant-2")).toBe("2026-03-27T10:00:07.000Z");
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion text", () => {
    expect(normalizeCompactToolLabel("Running formatter completed")).toBe("Running formatter");
    expect(normalizeCompactToolLabel("Write file complete")).toBe("Write file");
  });

  it("keeps labels without a completion suffix intact", () => {
    expect(normalizeCompactToolLabel("Searching repository")).toBe("Searching repository");
  });
});
