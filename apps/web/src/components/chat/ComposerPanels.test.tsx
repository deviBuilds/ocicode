import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ApprovalRequestId } from "@ocicode/contracts";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";

describe("composer chat-shell panels", () => {
  it("renders the pending approval summary and queue position", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: "approval-1" as ApprovalRequestId,
          requestKind: "command",
          createdAt: "2026-03-27T10:00:00.000Z",
          detail: "Run formatter",
        }}
        pendingCount={3}
      />,
    );

    expect(markup).toContain("Pending approval");
    expect(markup).toContain("Command approval requested");
    expect(markup).toContain("1/3");
  });

  it("renders the active user-input question and options", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId: "user-input-1" as ApprovalRequestId,
            createdAt: "2026-03-27T10:00:00.000Z",
            questions: [
              {
                id: "q-1",
                header: "Runtime",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "Full",
                    description: "Recommended for this task",
                  },
                  {
                    label: "Read-only",
                    description: "Safe but limited",
                  },
                ],
              },
            ],
          },
        ]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onSelectOption={() => {}}
        onAdvance={() => {}}
      />,
    );

    expect(markup).toContain("Runtime");
    expect(markup).toContain("Which mode should be used?");
    expect(markup).toContain("Full");
    expect(markup).toContain("Read-only");
  });

  it("renders the plan follow-up title in the ready banner", () => {
    const markup = renderToStaticMarkup(
      <ComposerPlanFollowUpBanner planTitle="Restore upstream chat shell parity" />,
    );

    expect(markup).toContain("Plan ready");
    expect(markup).toContain("Restore upstream chat shell parity");
  });
});
