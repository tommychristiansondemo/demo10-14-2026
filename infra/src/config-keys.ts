/**
 * Config_Store key constants referenced by the CDK stack.
 *
 * These mirror the keys each runtime component reads via the shared
 * {@link ConfigSource}/{@link loadConfig} abstraction, so the stack provisions
 * exactly the Config_Store entries the application expects at runtime
 * (Req 14.6, 15.1). Keeping them here avoids a build-time dependency from the
 * CDK app on every runtime package while keeping the names in one place.
 *
 * - `POLICY_TABLE_NAME_KEY` matches
 *   `packages/policy-lookup/src/server-config.ts`.
 * - `REPAIR_ESTIMATOR_ENVIRONMENT_KEY` matches
 *   `packages/repair-estimator/src/estimate-repair-tool.ts`.
 * - `BEDROCK_AGENT_ID_KEY` matches `packages/api/src/handler.ts`.
 */

/** Config_Store key holding the Policy_Table name (policy-lookup server). */
export const POLICY_TABLE_NAME_KEY = "claimclarify/policy-lookup/table-name";

/** Config_Store key scoping the repair-estimator server to an environment. */
export const REPAIR_ESTIMATOR_ENVIRONMENT_KEY = "repair-estimator/environment";

/** Config_Store key holding the Bedrock agent identifier the API forwards to. */
export const BEDROCK_AGENT_ID_KEY = "BEDROCK_AGENT_ID";
