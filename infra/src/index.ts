/**
 * ClaimClarify AWS CDK infrastructure public surface.
 *
 * Re-exports the stack class and construct references so later infrastructure
 * tasks (18/19) and the synthesis/snapshot tests (task 21) can attach to the
 * Policy_Table, S3_Origin, and Config_Store defined in task 17.1.
 */
export const APP_NAME = "ClaimClarify";

export {
  ClaimClarifyDataStack,
  PRIMARY_REGION,
  HOSTED_ZONE_NAME as PRIMARY_HOSTED_ZONE_NAME,
  PLACEHOLDER_HOSTED_ZONE_ID,
  DEFAULT_ZONE_SNAPSHOT,
  type ClaimClarifyDataStackProps,
  type ConfigStore,
} from "./claimclarify-stack";

export {
  ClaimClarifyCertificateStack,
  CERTIFICATE_REGION,
  HOSTED_ZONE_NAME,
  APP_DOMAIN_NAME,
  type ClaimClarifyCertificateStackProps,
} from "./claimclarify-certificate-stack";

export {
  ClaimClarifyCompute,
  type ClaimClarifyComputeProps,
} from "./claimclarify-compute-stack";

export {
  BEDROCK_AGENT_ID_KEY,
  POLICY_TABLE_NAME_KEY,
  REPAIR_ESTIMATOR_ENVIRONMENT_KEY,
} from "./config-keys";
