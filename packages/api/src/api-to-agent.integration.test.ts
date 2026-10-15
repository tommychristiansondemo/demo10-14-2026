/**
 * API-to-agent integration test (task 22.2, Req 2.1).
 *
 * Verifies the forwarding seam between the API_Layer and the Bedrock_Agent:
 * when the API_Layer receives a chat request from the Chat_UI, it forwards the
 * request to the Bedrock_Agent (Req 2.1).
 *
 * Unlike the handler unit tests (handler.test.ts), which assert the full HTTP
 * outcome mapping, this test focuses on the integration contract that a *valid*
 * request actually reaches the injected {@link AgentInvoker} carrying the
 * correct forwarded payload: the validated message, the shared `traceId`
 * created at the API_Layer, and the `agentId` resolved from the Config_Store.
 *
 * It wires the real {@link createChatHandler} against a fake AgentInvoker and a
 * real {@link InMemoryConfigSource} (the production ConfigSource contract),
 * exercising the loadConfig -> validate -> forward path end to end with no AWS.
 */

import { describe, expect, it, vi } from "vitest";
import { InMemoryConfigSource } from "@claimclarify/shared";
import {
  createChatHandler,
  AGENT_ID_CONFIG_KEY,
  type AgentInvocation,
  type AgentInvoker,
} from "./handler";

/** A fake AgentInvoker that records every invocation it receives. */
function recordingInvoker(response = "Triage summary.", sessionId = "sess-int") {
  const invocations: AgentInvocation[] = [];
  const invoker: AgentInvoker = {
    invoke: vi.fn(async (invocation: AgentInvocation) => {
      invocations.push(invocation);
      return { response, sessionId };
    }),
  };
  return { invoker, invocations };
}

describe("API-to-agent forwarding integration (Req 2.1)", () => {
  it("forwards a valid chat request to the agent with the message, traceId, and resolved agentId", async () => {
    const { invoker, invocations } = recordingInvoker("Here is the triage.", "sess-42");
    const configSource = new InMemoryConfigSource({
      [AGENT_ID_CONFIG_KEY]: "agent-prod-7",
    });
    const traceId = "trace-integration-0001";

    const handler = createChatHandler({
      configSource,
      agentInvoker: invoker,
      createTraceId: () => traceId,
    });

    const message = "Policy P-100 was rear-ended, is the repair covered?";
    const result = await handler({ body: JSON.stringify({ message }) });

    // The request reached the agent exactly once.
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    expect(invocations).toHaveLength(1);

    // And it carried the correct forwarded payload: the validated message, the
    // shared API-layer traceId, and the agentId resolved from the Config_Store.
    expect(invocations[0]).toEqual({
      request: { message },
      traceId,
      agentId: "agent-prod-7",
    });

    // The agent's result is returned to the Chat_UI with HTTP 200 (Req 2.2),
    // confirming the full forward-and-return path integrates.
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      response: "Here is the triage.",
      sessionId: "sess-42",
      traceId,
    });
  });

  it("resolves the agent id from the Config_Store at request time (not an embedded value)", async () => {
    const { invoker, invocations } = recordingInvoker();
    // A distinct, non-default agent id proves the id was read from config.
    const configSource = new InMemoryConfigSource({
      [AGENT_ID_CONFIG_KEY]: "agent-configured-xyz",
    });

    const handler = createChatHandler({
      configSource,
      agentInvoker: invoker,
      createTraceId: () => "trace-cfg",
    });

    await handler({ body: JSON.stringify({ message: "Hello there." }) });

    expect(invocations[0].agentId).toBe("agent-configured-xyz");
    expect(invocations[0].traceId).toBe("trace-cfg");
  });
});
