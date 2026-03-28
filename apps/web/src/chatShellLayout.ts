export const MAIN_SIDEBAR_WIDTH_STORAGE_KEY = "chat_main_sidebar_width";
export const MAIN_SIDEBAR_DEFAULT_WIDTH = "22rem";
export const MAIN_SIDEBAR_MIN_WIDTH = 13 * 16;
export const MAIN_SIDEBAR_MAX_WIDTH = 28 * 16;
export const CHAT_COMPOSER_MAX_WIDTH = "56.25rem";
export const MIN_CHAT_SHELL_CONTENT_WIDTH = 40 * 16;

export function shouldAcceptMainSidebarWidth(input: {
  nextSidebarWidth: number;
  shellWidth: number;
}): boolean {
  return input.shellWidth - input.nextSidebarWidth >= MIN_CHAT_SHELL_CONTENT_WIDTH;
}
