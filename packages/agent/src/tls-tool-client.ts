/**
 * Transport-encrypted MCP tool-client factory (Req 11.5, 12.5).
 *
 * The agent must call MCP servers over transport-encrypted connections. We
 * model that requirement with a thin {@link ToolClient} implementation that
 * delegates each invocation to an injected {@link EncryptedTransport}. The
 * production transport opens a TLS (HTTPS) MCP connection to the AgentCore
 * Runtime; it is injected here rather than hard-wired so the orchestration
 * layer stays unit-testable with a fake transport and no live AWS.
 *
 * This factory also enforces, as a defensive invariant, that the configured
 * endpoint uses a TLS scheme (`https:`), so a misconfiguration that would send
 * tool traffic in the clear fails fast instead of silently downgrading.
 */

import type { Traced, ToolInvocation } from "@claimclarify/shared";
import type { ToolClient } from "./tool-client";

/**
 * An injected transport that performs the actual encrypted MCP call. The
 * production implementation performs a TLS request to the given endpoint; test
 * implementations are fakes.
 */
export type EncryptedTransport = (
  endpoint: string,
  invocation: Traced<ToolInvocation>
) => Promise<unknown>;

/** Configuration for the TLS-backed tool client. */
export interface TlsToolClientConfig {
  /** The MCP endpoint. Must be an `https:` (TLS) URL (Req 11.5). */
  endpoint: string;
  /** The injected encrypted transport. */
  transport: EncryptedTransport;
}

/** Thrown when a tool client is configured with a non-TLS endpoint. */
export class InsecureEndpointError extends Error {
  constructor(endpoint: string) {
    super(
      `MCP tool endpoint must use a transport-encrypted (https) connection, got: ${endpoint}`
    );
    this.name = "InsecureEndpointError";
  }
}

/** Returns true iff the endpoint uses the TLS (`https:`) scheme. */
export function isTlsEndpoint(endpoint: string): boolean {
  try {
    return new URL(endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build a {@link ToolClient} that routes every invocation through a
 * transport-encrypted connection (Req 11.5). The shared `traceId` is already
 * stamped on the invocation by the orchestrator and is passed straight through
 * to the transport (Req 12.5).
 *
 * @throws InsecureEndpointError if the endpoint is not an `https:` URL.
 */
export function createTlsToolClient(config: TlsToolClientConfig): ToolClient {
  if (!isTlsEndpoint(config.endpoint)) {
    throw new InsecureEndpointError(config.endpoint);
  }
  return {
    invoke(invocation: Traced<ToolInvocation>): Promise<unknown> {
      return config.transport(config.endpoint, invocation);
    },
  };
}
