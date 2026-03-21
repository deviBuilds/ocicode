import { Outlet, createFileRoute, useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import ThreadSidebar from "../components/Sidebar";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
} from "~/components/ui/sidebar";
import {
  MAIN_SIDEBAR_DEFAULT_WIDTH,
  MAIN_SIDEBAR_MAX_WIDTH,
  MAIN_SIDEBAR_MIN_WIDTH,
  MAIN_SIDEBAR_WIDTH_STORAGE_KEY,
  shouldAcceptMainSidebarWidth,
} from "~/chatShellLayout";

function ChatRouteLayout() {
  const navigate = useNavigate();

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  const acceptMainSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const chatColumn = document.querySelector<HTMLElement>(
        "[data-chat-shell-center-column='true']",
      );
      if (!chatColumn) {
        return true;
      }

      const diffOpen =
        document.querySelector("[data-chat-inline-diff-panel='open']") !== null;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const nextChatColumnWidth = chatColumn.getBoundingClientRect().width;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return shouldAcceptMainSidebarWidth({
        chatColumnWidth: nextChatColumnWidth,
        diffOpen,
      });
    },
    [],
  );

  return (
    <SidebarProvider
      defaultOpen
      className="min-h-svh chat-shell-surface"
      style={{ "--sidebar-width": MAIN_SIDEBAR_DEFAULT_WIDTH } as CSSProperties}
    >
      <Sidebar
        side="left"
        collapsible="offcanvas"
        className="border-r border-border/70 bg-sidebar text-foreground"
        resizable={{
          maxWidth: MAIN_SIDEBAR_MAX_WIDTH,
          minWidth: MAIN_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: acceptMainSidebarWidth,
          storageKey: MAIN_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <ThreadSidebar />
        <SidebarRail />
      </Sidebar>
      <DiffWorkerPoolProvider>
        <div className="chat-shell-surface flex min-h-0 min-w-0 flex-1 animate-fade-in">
          <Outlet />
        </div>
      </DiffWorkerPoolProvider>
    </SidebarProvider>
  );
}

export const Route = createFileRoute("/_chat")({
  component: ChatRouteLayout,
});
