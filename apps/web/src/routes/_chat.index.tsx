import { createFileRoute } from "@tanstack/react-router";
import { SquarePenIcon } from "lucide-react";

import { isElectron } from "../env";
import { SidebarTrigger, useSidebar } from "../components/ui/sidebar";
import { OciWordmark } from "../components/OciWordmark";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Button } from "../components/ui/button";

function ChatIndexRouteView() {
  const { toggleSidebar, open } = useSidebar();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {!isElectron && (
        <header className="border-b border-border px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground">Threads</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
          <span className="text-xs text-muted-foreground/50">No active thread</span>
        </div>
      )}

      <Empty className="relative">
        {/* Subtle animated gradient background */}
        <div className="animate-welcome-glow pointer-events-none absolute inset-0 opacity-30 dark:opacity-20">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--primary)_0%,transparent_70%)] opacity-8" />
        </div>

        <EmptyHeader className="relative max-w-md gap-4">
          <OciWordmark className="mb-2 h-5" />
          <EmptyTitle className="text-2xl">Welcome to OCI Code</EmptyTitle>
          <EmptyDescription className="text-muted-foreground/60">
            Select a thread from the sidebar or create a new one to start building.
          </EmptyDescription>
        </EmptyHeader>

        <div className="relative mt-2 flex items-center gap-3">
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              if (!open) toggleSidebar();
            }}
          >
            <SquarePenIcon className="mr-1.5 size-3.5" />
            New Thread
          </Button>
          <span className="text-xs text-muted-foreground/40">
            or use the sidebar
          </span>
        </div>
      </Empty>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
