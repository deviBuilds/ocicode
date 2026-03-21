export const MAIN_SIDEBAR_WIDTH_STORAGE_KEY = "chat_main_sidebar_width";
export const MAIN_SIDEBAR_DEFAULT_WIDTH = "22rem";
export const MAIN_SIDEBAR_MIN_WIDTH = 17.5 * 16;
export const MAIN_SIDEBAR_MAX_WIDTH = 28 * 16;
export const CHAT_COMPOSER_MAX_WIDTH = "56.25rem";
export const MIN_CHAT_COLUMN_WIDTH = 760;
export const MIN_CHAT_COLUMN_WIDTH_WITH_DIFF = 640;

export function minChatColumnWidthForShell(diffOpen: boolean): number {
  return diffOpen ? MIN_CHAT_COLUMN_WIDTH_WITH_DIFF : MIN_CHAT_COLUMN_WIDTH;
}

export function shouldAcceptMainSidebarWidth(input: {
  chatColumnWidth: number;
  diffOpen: boolean;
}): boolean {
  return input.chatColumnWidth >= minChatColumnWidthForShell(input.diffOpen);
}
