/**
 * The `estimate_repair` MCP tool handler for the Repair_Estimator_Server
 * (Req 6.1–6.5, 12.1, 12.2, 12.5, 13.3, 15.2).
 *
 * This module contains the tool's behavior as a plain, injectable function so
 * it is fully unit-testable without the MCP transport or any live AWS service.
 * The SDK wiring (tool listing + dispatch) lives in `./server.ts` and delegates
 * to {@link handleEstimateRepair} here.
 *
 * Behavior (design.md "Repair_Estimator_Server"):
 * - Validate `Claim_Input` against the schema before processing via
 *   {@link validateClaimInput}; on failure return a structured VALIDATION_ERROR
 *   naming the field and NO estimate (Req 6.5, 13.3, 13.4).
 * - For valid input return the deterministic estimate from {@link estimateRepair}:
 *   a `severity` from the predefined set, a non-negative cost, and a
 *   non-negative turnaround (Req 6.2, 6.3, 6.4).
 * - Emit logs/metrics carrying the shared `traceId` (Req 12.1, 12.2, 12.5).
 */
import type { ConfigSource, EstimateResult, StructuredError } from "@claimclarify/shared";
import { loadConfig } from "@claimclarify/shared";

import { estimateRepair } from "./estimate-repair";
import { maxVehicleYear, validateClaimInput } from "./validate-claim-input";
import type { Observability } from "./observability";

/** The MCP tool name exposed by the Repair_Estimator_Server. */
export const ESTIMATE_REPAIR_TOOL = "estimate_repair";

/**
 * Config key (read from the Config_Store at runtime) that scopes the server to
 * an environment. There is no source-embedded fallback: if the key is absent
 * the handler returns a CONFIG_ERROR (Req 15.2, 15.3).
 */
export const ENVIRONMENT_CONFIG_KEY = "repair-estimator/environment";

/** Discriminated result of the `estimate_repair` tool. */
export type EstimateRepairResult =
  | { ok: true; estimate: EstimateResult }
  | { ok: false; error: StructuredError };

/** Dependencies injected into {@link handleEstimateRepair}. */
export interface EstimateRepairDeps {
  /** Config_Store abstraction read at runtime (Req 15.2). */
  readonly config: ConfigSource;
  /** Logger + metrics sinks, each stamped with the shared `traceId`. */
  readonly observability: Observability;
  /**
   * Maximum permitted `vehicleYear` (defaults to currentYear + 1). Injectable
   * so tests stay deterministic.
   */
  readonly currentYearMax?: number;
  /** Monotonic clock in milliseconds for latency metrics; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Handle one `estimate_repair` invocation.
 *
 * @param rawInput the untrusted tool arguments (candidate `Claim_Input`).
 * @param traceId the shared request trace identifier created at the API_Layer
 *   and propagated to this tool invocation (Req 12.5).
 * @param deps injected Config_Store and observability dependencies.
 * @returns a well-formed estimate on success, or a structured error
 *   (CONFIG_ERROR when config is unavailable; VALIDATION_ERROR for invalid input).
 */
export function handleEstimateRepair(
  rawInput: unknown,
  traceId: string,
  deps: EstimateRepairDeps,
): EstimateRepairResult {
  const { config, observability } = deps;
  const { logger, metrics } = observability;
  const now = deps.now ?? Date.now;
  const dimensions = { traceId, tool: ESTIMATE_REPAIR_TOOL } as const;

  const start = now();
  logger.info("estimate_repair invoked", { traceId, tool: ESTIMATE_REPAIR_TOOL });
  metrics.count("Invocations", 1, dimensions);

  const finish = (result: EstimateRepairResult): EstimateRepairResult => {
    metrics.timing("LatencyMillis", Math.max(0, now() - start), dimensions);
    return result;
  };

  // Load environment config from the Config_Store at runtime; never fall back
  // to a value embedded in source code (Req 15.2, 15.3).
  const configResult = loadConfig(config, ENVIRONMENT_CONFIG_KEY);
  if (!configResult.ok) {
    logger.error("configuration retrieval failed", {
      traceId,
      tool: ESTIMATE_REPAIR_TOOL,
      configKey: ENVIRONMENT_CONFIG_KEY,
      errorType: configResult.error.type,
    });
    metrics.count("Errors", 1, dimensions);
    return finish({ ok: false, error: configResult.error });
  }

  // Validate Claim_Input against the schema before processing (Req 6.5, 13.3).
  const validation = validateClaimInput(
    rawInput,
    deps.currentYearMax ?? maxVehicleYear(),
  );
  if (!validation.ok) {
    logger.error("Claim_Input validation failed", {
      traceId,
      tool: ESTIMATE_REPAIR_TOOL,
      field: validation.error.field,
    });
    metrics.count("Errors", 1, dimensions);
    // No severity/cost/turnaround on validation failure (Req 6.5, 13.4).
    return finish({ ok: false, error: validation.error });
  }

  // Deterministic estimation for valid input (Req 6.2, 6.3, 6.4).
  const estimate = estimateRepair(validation.value);
  logger.info("estimate_repair succeeded", {
    traceId,
    tool: ESTIMATE_REPAIR_TOOL,
    severity: estimate.severity,
  });
  return finish({ ok: true, estimate });
}
