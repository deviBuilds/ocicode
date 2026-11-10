import { usePreviewPanelInlineSize } from "../../hooks/usePreviewPanelInlineSize";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelPanes, RightPanelTabs, type RightPanelPanesProps } from "../RightPanelTabs";

type ChatRightPanelProps = Omit<RightPanelPanesProps, "mode" | "inlineSize" | "maximized"> & {
  readonly sheet: boolean;
  readonly maximized: boolean;
  readonly workspaceLayoutElement: HTMLElement | null;
  readonly widthStorageKey: string;
  readonly sheetAnimationDurationMs: number;
  readonly onCloseSheet: () => void;
};

/**
 * The right panel, inline beside the chat column or as a sheet on narrow
 * layouts. Its width follows a resize drag every frame, so the width state
 * lives here rather than in ChatView.
 */
export function ChatRightPanel(props: ChatRightPanelProps) {
  const {
    sheet,
    workspaceLayoutElement,
    widthStorageKey,
    sheetAnimationDurationMs,
    onCloseSheet,
    maximized,
    layoutControls,
    panes,
    paneSizes,
    cornerControls,
    renderPane,
    onMovePane,
    onHidePane,
    onResizePanes,
    ...tabs
  } = props;
  const inlineSize = usePreviewPanelInlineSize({
    container: workspaceLayoutElement,
    widthStorageKey,
  });
  if (!sheet) {
    return (
      <RightPanelPanes
        {...tabs}
        panes={panes}
        paneSizes={paneSizes}
        cornerControls={cornerControls}
        onResizePanes={onResizePanes}
        renderPane={renderPane}
        onMovePane={onMovePane}
        onHidePane={onHidePane}
        mode="inline"
        maximized={maximized}
        inlineSize={inlineSize}
      />
    );
  }
  return (
    <RightPanelSheet
      animationDurationMs={sheetAnimationDurationMs}
      open={tabs.open === true}
      onClose={onCloseSheet}
    >
      <RightPanelTabs
        {...tabs}
        mode="sheet"
        inlineSize={inlineSize}
        layoutControls={layoutControls}
      />
    </RightPanelSheet>
  );
}
