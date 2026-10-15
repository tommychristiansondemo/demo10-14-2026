/**
 * MCP server wiring for the Policy_Lookup_Server (task 12.1).
 *
 * Binds the framework-agnostic {@link PolicyToolRegistry} onto the real
 * `@modelcontextprotocol/sdk` high-level server, exposing `get_coverage`,
 * `get_deductibles`, and `get_prior_claims` as MCP tools (Req 4.1–4.6). Each
 * registered tool handler delegates straight to the registry's dispatcher, so
 * input validation (Req 13.2), read-only DynamoDB access (Req 10.2), and
 * observability with the shared `traceId` (Req 12.1, 12.2, 12.5) all live in one
 * tested place.
 *
 * The MCP SDK is required lazily so that importing the registry/adapter for unit
 * tests does not force the transport dependency to load, and so the package
 * builds and tests without live AWS or a running transport.
 */
import {
  POLICY_TOOL_NAMES,
  PolicyToolRegistry,
  type PolicyToolDeps,
  type PolicyToolName,
  type PolicyToolRawInput,
} from "./tool-registry";

/** Minimal shape of the MCP server we depend on (subset of the SDK's API). */
export interface McpServerLike {
  registerTool(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: unknown;
    },
    handler: (
      args: PolicyToolRawInput,
      extra: { requestId?: string | number },
    ) => Promise<McpToolCallResult>,
  ): unknown;
  connect(transport: unknown): Promise<void>;
}

/** The MCP tool-call result envelope expected by the SDK. */
export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** Options for {@link createPolicyLookupMcpServer}. */
export interface CreatePolicyMcpServerOptions extends PolicyToolDeps {
  /**
   * Trace id resolver for an incoming tool call. Defaults to using the MCP
   * request id so each invocation carries a correlating identifier
   * (Req 12.5). Production can override to adopt the id propagated by the agent.
   */
  resolveTraceId?: (extra: { requestId?: string | number }) => string;
  /**
   * Injectable server factory (for tests). Defaults to constructing a real
   * `@modelcontextprotocol/sdk` `McpServer`.
   */
  createServer?: () => McpServerLike;
}

/**
 * Create and configure an MCP server exposing the three policy-lookup tools.
 * The returned server has all tools registered and is ready to `connect` to a
 * transport (e.g. stdio/HTTP) by the AgentCore runtime entrypoint.
 */
export function createPolicyLookupMcpServer(
  options: CreatePolicyMcpServerOptions,
): { server: McpServerLike; registry: PolicyToolRegistry } {
  const registry = new PolicyToolRegistry(options);
  const resolveTraceId =
    options.resolveTraceId ??
    ((extra) =>
      extra.requestId !== undefined ? String(extra.requestId) : "unknown");

  const server = (options.createServer ?? defaultCreateServer)();

  for (const definition of registry.definitions()) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: buildInputSchema(),
      },
      async (args, extra) => {
        const traceId = resolveTraceId(extra);
        const result = await registry.dispatch(
          definition.name as PolicyToolName,
          args ?? {},
          { traceId },
        );
        return toMcpResult(result);
      },
    );
  }

  return { server, registry };
}

/** Convert a {@link LookupResult} into the MCP tool-call envelope. */
function toMcpResult(result: {
  ok: boolean;
  data?: unknown;
  error?: unknown;
}): McpToolCallResult {
  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data) }],
      structuredContent: { data: result.data } as Record<string, unknown>,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result.error) }],
    isError: true,
    structuredContent: { error: result.error } as Record<string, unknown>,
  };
}

/**
 * Build the zod raw-shape input schema (`{ policyId }`) the SDK uses to
 * advertise and parse tool inputs. Lazily requires `zod` so pure unit tests of
 * the registry need not load it.
 */
function buildInputSchema(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { z } = require("zod") as typeof import("zod");
  return {
    policyId: z
      .string()
      .min(1)
      .max(64)
      .describe("The policy identifier to look up."),
  };
}

/** Default factory constructing a real MCP SDK server. */
function defaultCreateServer(): McpServerLike {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js") as {
    McpServer: new (info: { name: string; version: string }) => McpServerLike;
  };
  return new McpServer({ name: "policy-lookup", version: "0.1.0" });
}

/** Re-export tool names for entrypoint convenience. */
export { POLICY_TOOL_NAMES };
