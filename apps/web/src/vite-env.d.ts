/// <reference types="vite/client" />

import type { NativeApi, DesktopBridge } from "@ocicode/contracts";

declare global {
  interface Window {
    nativeApi?: NativeApi;
    desktopBridge?: DesktopBridge;
  }
}
