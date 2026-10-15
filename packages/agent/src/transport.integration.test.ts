/**
 * Agent-to-MCP transport integration test (task 22.2, Req 11.5).
 *
 * Verifies the transport seam the agent uses to reach the MCP servers: when the
 * Bedrock_Agent invokes a tool on an MCP server, it uses a transport-encrypted
 * connection (Req 11.5).
 *
 * The agent never opens a socket directly; it depends on the {@link ToolClient}
 * abstraction produced by {@link createTlsToolClient}, which routes every
 * invocation through an injected (TLS) transport and refuses to construct a
 * client for a non-encrypted endpoint. This test exercises that factory with a
 * real traced invocation (as the orchestrator stamps it) and asserts:
 *
 * 1. an `https:` (transport-encrypted) endpoint is accepted and the injected
 *    transport is invoked with the endpoint and the full traced invocation, and
 * 2. a non-`https:` (`http://`) endpoint is rejected because a
 *    transport-encrypted connection is required.
 */

import { describe, expect, it, vi } from "vitest";
import type { Traced, ToolInvocation } from "@claimclarify/shared";
import {
  createTlsToolClient,
  InsecureEndpointError,
  type EncryptedTransport,
} from "./tls-tool-client";

/** A traced invocation as the orchestrator would hand it to the client. */
function tracedInvocation(): Traced<ToolInvocation> {
  return {
    tool: "get_coverage",
    input: { policyId: "P-100" },
    traceId: "trace-transport-0001",
  };
}

describe("Agent-to-MCP transport integration (Req 11.5)", () => {
  it("accepts an https endpoint and invokes the encrypted transport with the traced invocation", async () => {
    const seen: { endpoint: string; invocation: Traced<ToolInvocation> }[] = [];
    const transport: EncryptedTransport = vi.fn(async (endpoint, invocation) => {
      seen.push({ endpoint, invocation });
      return { coverage: "comprehensive" };
    });

    const endpoint = "https://runtime.us-east-2.amazonaws.com/mcp/policy-lookup";
    const client = createTlsToolClient({ endpoint, transport });

    const invocation = tracedInvocation();
    const result = await client.invoke(invocation);

    // The agent's tool call went out over the (TLS) transport, not direct I/O.
    expect(transport).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);

    // The transport received the encrypted endpoint and the full traced
    // invocation, with the shared traceId propagated end to end (Req 12.5).
    expect(seen[0].endpoint).toBe(endpoint);
    expect(seen[0].invocation).toEqual(invocation);
    expect(seen[0].invocation.traceId).toBe("trace-transport-0001");

    // The transport's result flows back through the client unchanged.
    expect(result).toEqual({ coverage: "comprehensive" });
  });

  it("rejects a non-https endpoint because a transport-encrypted connection is required", () => {
    const transport: EncryptedTransport = vi.fn(async () => ({}));

    expect(() =>
      createTlsToolClient({
        endpoint: "http://runtime.us-east-2.amazonaws.com/mcp/policy-lookup",
        transport,
      })
    ).toThrow(InsecureEndpointError);

    // A rejected (insecure) configuration must never send tool traffic.
    expect(transport).not.toHaveBeenCalled();
  });
});
