/**
 * Unit tests for the transport-encrypted MCP tool-client factory (Req 11.5,
 * 12.5): TLS enforcement and trace-id pass-through.
 */
import { describe, expect, it } from "vitest";
import type { Traced, ToolInvocation } from "@claimclarify/shared";

import {
  createTlsToolClient,
  isTlsEndpoint,
  InsecureEndpointError,
} from "./tls-tool-client";

describe("isTlsEndpoint", () => {
  it("accepts https endpoints", () => {
    expect(isTlsEndpoint("https://runtime.example.com/mcp")).toBe(true);
  });

  it("rejects http and malformed endpoints", () => {
    expect(isTlsEndpoint("http://runtime.example.com/mcp")).toBe(false);
    expect(isTlsEndpoint("not-a-url")).toBe(false);
  });
});

describe("createTlsToolClient", () => {
  it("throws InsecureEndpointError for a non-TLS endpoint", () => {
    expect(() =>
      createTlsToolClient({
        endpoint: "http://runtime.example.com/mcp",
        transport: async () => ({}),
      })
    ).toThrow(InsecureEndpointError);
  });

  it("routes the invocation through the encrypted transport, preserving traceId", async () => {
    const seen: { endpoint: string; invocation: Traced<ToolInvocation> }[] = [];
    const client = createTlsToolClient({
      endpoint: "https://runtime.example.com/mcp",
      transport: async (endpoint, invocation) => {
        seen.push({ endpoint, invocation });
        return { ok: true };
      },
    });

    const invocation: Traced<ToolInvocation> = {
      tool: "get_coverage",
      input: { policyId: "P1" },
      traceId: "trace-123",
    };
    const result = await client.invoke(invocation);

    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].endpoint).toBe("https://runtime.example.com/mcp");
    expect(seen[0].invocation.traceId).toBe("trace-123");
  });
});
