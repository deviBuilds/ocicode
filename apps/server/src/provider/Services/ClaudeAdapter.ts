import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ClaudeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "claudeAgent";
}

export class ClaudeAdapter extends ServiceMap.Service<ClaudeAdapter, ClaudeAdapterShape>()(
  "ocicode/provider/Services/ClaudeAdapter",
) {}
