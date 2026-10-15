/**
 * Framework-agnostic MCP tool registration & dispatch layer for the
 * Policy_Lookup_Server (task 12.1).
 *
 * This layer defines the three MCP tools (`get_coverage`, `get_deductibles`,
 * `get_prior_claims`) with their input schema and a dispatcher that:
 *
 * 1. validates the tool input via {@link validatePolicyId} BEFORE any store
 *    access (Req 13.2) — invalid input never touches DynamoDB;
 * 2. reads the record from the injected read-only {@link AsyncPolicyStore}
 *    (DynamoDB adapter in production, fake in tests), wraps it in an in-memory
 *    snapshot, and delegates to the existing pure lookup tools so all read
 *    semantics (fidelity, NOT_FOUND) stay the single source of truth
 *    (Req 4.2–4.5);
 * 3. emits a structured log and a latency/error metric stamped with the shared
 *    `traceId` (Req 12.1, 12.2, 12.5).
 *
 * It depends only on plain interfaces, so it is fully unit-testable without the
 * MCP transport or live AWS. The {@link createPolicyLookupMcpServer} wrapper
 * (mcp-server.ts) binds this registry onto the real `@modelcontextprotocol/sdk`
 * server.
 */
import type { StructuredError } from "@claimclarify/shared";

import type { AsyncPolicyStore } from "./dynamodb-store";
import { InMemoryPolicyStore } from "./store";
import {
  type LookupResult,
  getCoverage,
  getDeductibles,
  getPriorClaims,
} from "./lookup-tools";
import { validatePolicyId } from "./validation";
import {
  ConsoleLogger,
  NoopMetrics,
  type Logger,
  type Metrics,
} from "./observability";

/** The three MCP tool names exposed by the Policy_Lookup_Server. */
export const POLICY_TOOL_NAMES = [
  "get_coverage",
  "get_deductibles",
  "get_prior_claims",
] as const;

/** Union of the exposed policy tool names. */
export type PolicyToolName = (typeof POLICY_TOOL_NAMES)[number];

/**
 * JSON-schema description of the shared `{ policyId: string }` tool input. Used
 * both to advertise the tool over MCP and as human/machine documentation. The
 * authoritative validation is {@link validatePolicyId} (Req 13.2).
 */
export const POLICY_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    policyId: {
      type: "string",
      minLength: 1,
      maxLength: 64,
      description: "The policy identifier to look up.",
    },
  },
  required: ["policyId"],
  additionalProperties: false,
} as const;

/** Metadata describing a single MCP tool. */
export interface PolicyToolDefinition {
  name: PolicyToolName;
  description: string;
  inputSchema: typeof POLICY_TOOL_INPUT_SCHEMA;
}

/** Context threaded through a dispatch call. */
export interface DispatchContext {
  /** Shared request trace identifier (Req 12.5). */
  traceId: string;
}

/** Dependencies the registry dispatches against. */
export interface PolicyToolDeps {
  /** Read-only async store (DynamoDB adapter in production). */
  store: AsyncPolicyStore;
  /** Structured logger (defaults to {@link ConsoleLogger}). */
  logger?: Logger;
  /** Metrics sink (defaults to {@link NoopMetrics}). */
  metrics?: Metrics;
  /** Injectable clock for latency measurement (defaults to `Date.now`). */
  now?: () => number;
}

/** Raw (untrusted) tool input. */
export interface PolicyToolRawInput {
  policyId?: unknown;
}

/**
 * Maps each tool name to the pure lookup function it delegates to. The pure
 * functions validate the id and read from a synchronous {@link PolicyStore}.
 */
const PURE_TOOLS: Record<
  PolicyToolName,
  (store: InMemoryPolicyStore, input: PolicyToolRawInput) => LookupResult<unknown>
> = {
  get_coverage: (store, input) => getCoverage(store, input),
  get_deductibles: (store, input) => getDeductibles(store, input),
  get_prior_claims: (store, input) => getPriorClaims(store, input),
};

/** Human-readable descriptions per tool. */
const TOOL_DESCRIPTIONS: Record<PolicyToolName, string> = {
  get_coverage: "Return the coverage details for an existing policy identifier.",
  get_deductibles:
    "Return the deductible amounts for an existing policy identifier.",
  get_prior_claims:
    "Return the prior claim history for an existing policy identifier.",
};

/**
 * Build the list of tool definitions advertised by the server. Each uses the
 * shared `{ policyId }` input schema.
 */
export function listPolicyToolDefinitions(): PolicyToolDefinition[] {
  return POLICY_TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: POLICY_TOOL_INPUT_SCHEMA,
  }));
}

/**
 * The registry/dispatcher. Holds the injected dependencies and exposes a single
 * {@link dispatch} entry point that the MCP transport layer calls per tool
 * invocation.
 */
export class PolicyToolRegistry {
  private readonly store: AsyncPolicyStore;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly now: () => number;

  constructor(deps: PolicyToolDeps) {
    this.store = deps.store;
    this.logger = deps.logger ?? new ConsoleLogger();
    this.metrics = deps.metrics ?? new NoopMetrics();
    this.now = deps.now ?? Date.now;
  }

  /** Tool definitions this registry serves. */
  definitions(): PolicyToolDefinition[] {
    return listPolicyToolDefinitions();
  }

  /**
   * Validate, read, and delegate for a single tool invocation.
   *
   * - Input is validated first; an invalid `policyId` short-circuits with a
   *   VALIDATION_ERROR and never reads the store (Req 13.2, 4.6).
   * - On valid input the record is fetched read-only; a per-record in-memory
   *   snapshot drives the pure tool so fidelity and NOT_FOUND semantics are
   *   preserved (Req 4.2–4.5).
   * - A log and a latency/error metric are emitted with the shared `traceId`
   *   (Req 12.1, 12.2, 12.5).
   */
  async dispatch(
    tool: PolicyToolName,
    input: PolicyToolRawInput,
    ctx: DispatchContext,
  ): Promise<LookupResult<unknown>> {
    const start = this.now();

    // 1) Validate input before any store access (Req 13.2).
    const validation = validatePolicyId(input?.policyId);
    if (!validation.ok) {
      return this.finish(tool, ctx, start, { ok: false, error: validation.error });
    }

    // 2) Read-only fetch, then delegate to the pure tool over a snapshot.
    let result: LookupResult<unknown>;
    try {
      const record = await this.store.fetch(validation.policyId);
      const snapshot = new InMemoryPolicyStore(record ? [record] : []);
      result = PURE_TOOLS[tool](snapshot, { policyId: validation.policyId });
    } catch (cause) {
      // A store/dependency failure is normalized to a structured error that
      // names the dependency and preserves the trace for correlation.
      const error: StructuredError = {
        type: "DEPENDENCY_ERROR",
        dependency: "Policy_Table",
        message:
          cause instanceof Error
            ? `Policy_Table read failed: ${cause.message}`
            : "Policy_Table read failed",
      };
      result = { ok: false, error };
    }

    return this.finish(tool, ctx, start, result);
  }

  /** Emit observability for the completed invocation and return the result. */
  private finish(
    tool: PolicyToolName,
    ctx: DispatchContext,
    start: number,
    result: LookupResult<unknown>,
  ): LookupResult<unknown> {
    const latencyMs = Math.max(0, this.now() - start);
    const errored = !result.ok;

    this.logger.log({
      level: errored ? "warn" : "info",
      tool,
      traceId: ctx.traceId,
      message: errored
        ? `${tool} returned ${result.error.type}`
        : `${tool} succeeded`,
      context: errored ? { errorType: result.error.type } : undefined,
    });

    this.metrics.record({
      tool,
      traceId: ctx.traceId,
      latencyMs,
      error: errored,
    });

    return result;
  }
}
