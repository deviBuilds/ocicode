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
    <div className="chat-shell-surface flex min-h-0 min-w-0 flex-1 flex-col">
      {!isElectron && (
        <header className="chat-shell-surface border-b border-border/70 px-4 py-3 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="text-sm font-medium text-foreground/84">Threads</span>
          </div>
        </header>
      )}

      {isElectron && (
        <div className="chat-shell-surface drag-region flex h-[52px] shrink-0 items-center border-b border-border/70 px-6">
          <span className="text-xs font-medium tracking-[0.08em] text-muted-foreground/58">
            No active thread
          </span>
        </div>
      )}

      <Empty className="relative px-6">
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.05),transparent_55%)]" />
        <EmptyHeader className="relative max-w-lg gap-5 rounded-[28px] border border-border/70 bg-card/70 px-8 py-10 text-left shadow-[0_22px_48px_rgba(0,0,0,0.12)] supports-[backdrop-filter]:bg-card/60 supports-[backdrop-filter]:backdrop-blur-xl">
          <OciWordmark className="h-4.5 text-foreground/88" />
          <div className="space-y-2">
            <EmptyTitle className="text-3xl font-semibold tracking-tight text-foreground/92">
              Start from a thread or open a project.
            </EmptyTitle>
            <EmptyDescription className="max-w-md text-sm leading-6 text-muted-foreground/66">
              Use the sidebar to jump back into recent work, or create a new thread for the
              project you want to change next.
            </EmptyDescription>
          </div>
        </EmptyHeader>

        <div className="relative mt-5 flex flex-wrap items-center justify-center gap-3">
          <Button
            variant="outline"
            size="sm"
            className="h-10 rounded-full border-border/80 bg-background/80 px-4 shadow-xs/5"
            onClick={() => {
              if (!open) toggleSidebar();
            }}
          >
            <SquarePenIcon className="mr-1.5 size-3.5" />
            Browse threads
          </Button>
          <span className="text-xs uppercase tracking-[0.12em] text-muted-foreground/42">
            sidebar-first workflow
          </span>
        </div>
      </Empty>
    </div>
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
