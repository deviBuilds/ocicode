import { APP_BASE_NAME } from "@ocicode/shared/branding";

export { APP_BASE_NAME };
export const APP_STAGE_LABEL = import.meta.env.DEV ? "Dev" : "Alpha";
export const APP_DISPLAY_NAME = `${APP_BASE_NAME} (${APP_STAGE_LABEL})`;
