/**
 * ClaimClarify policy-lookup MCP server.
 *
 * Pure logic (store interface, in-memory fake, policyId validation) lives here
 * and is importable by the MCP server (task 12) and property tests (tasks
 * 4.3–4.5). The three read-only lookup tools land here too (task 4.2); the
 * MCP/DynamoDB wiring lands in task 12.
 */
export type { PolicyRecord, StructuredError } from "@claimclarify/shared";

export {
  type PolicyStore,
  InMemoryPolicyStore,
} from "./store";
export {
  POLICY_ID_FIELD,
  type PolicyIdValidationResult,
  validatePolicyId,
} from "./validation";
export {
  type LookupResult,
  type PolicyLookupInput,
  getCoverage,
  getDeductibles,
  getPriorClaims,
} from "./lookup-tools";

export {
  type Logger,
  type Metrics,
  type LogEntry,
  type MetricEntry,
  ConsoleLogger,
  NoopMetrics,
} from "./observability";
export {
  type AsyncPolicyStore,
  type DynamoDbReader,
  type GetItemLike,
  type GetCommandFactory,
  type DynamoDBPolicyStoreOptions,
  DynamoDBPolicyStore,
  createDynamoDbReader,
} from "./dynamodb-store";
export {
  type PolicyToolName,
  type PolicyToolDefinition,
  type PolicyToolDeps,
  type PolicyToolRawInput,
  type DispatchContext,
  POLICY_TOOL_NAMES,
  POLICY_TOOL_INPUT_SCHEMA,
  PolicyToolRegistry,
  listPolicyToolDefinitions,
} from "./tool-registry";
export {
  POLICY_TABLE_NAME_KEY,
  loadPolicyTableName,
} from "./server-config";
export {
  type McpServerLike,
  type McpToolCallResult,
  type CreatePolicyMcpServerOptions,
  createPolicyLookupMcpServer,
} from "./mcp-server";
