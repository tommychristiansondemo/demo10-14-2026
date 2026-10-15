/**
 * ClaimClarify repair-estimator MCP server.
 *
 * Pure, deterministic estimation logic (validation, classification, estimation)
 * lives in this package so it can be imported by both the MCP server (task 13)
 * and the property-based tests without AWS I/O. This index re-exports the shared
 * contracts and the pure logic implemented so far.
 */
export type { ClaimInput, EstimateResult, Severity, StructuredError } from "@claimclarify/shared";

export {
  validateClaimInput,
  maxVehicleYear,
  type ValidateClaimInputResult,
} from "./validate-claim-input";

export { estimateRepair } from "./estimate-repair";

export {
  ESTIMATE_REPAIR_TOOL,
  ENVIRONMENT_CONFIG_KEY,
  handleEstimateRepair,
  type EstimateRepairDeps,
  type EstimateRepairResult,
} from "./estimate-repair-tool";

export {
  type Logger,
  type LogFields,
  type Metrics,
  type MetricName,
  type MetricDimensions,
  type Observability,
  noopLogger,
  noopMetrics,
  noopObservability,
} from "./observability";

export { createRepairEstimatorServer } from "./server";
