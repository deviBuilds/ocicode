/**
 * ProviderHealth - Provider readiness snapshot service.
 *
 * Owns startup-time provider health checks (install/auth reachability) and
 * exposes the cached results to transport layers.
 *
 * @module ProviderHealth
 */
import type { ProviderBridgeHealthInput, ServerProviderStatus } from "@ocicode/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface ProviderHealthShape {
  /**
   * Read provider health statuses computed at server startup.
   */
  readonly getStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Resolve a provider status for the supplied mode/options.
   */
  readonly checkStatus: (input: ProviderBridgeHealthInput) => Effect.Effect<ServerProviderStatus>;
}

export class ProviderHealth extends ServiceMap.Service<ProviderHealth, ProviderHealthShape>()(
  "ocicode/provider/Services/ProviderHealth",
) {}
