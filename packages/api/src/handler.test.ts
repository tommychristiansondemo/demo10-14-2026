/**
 * Unit tests for the API_Layer chat handler mapping (task 11.2).
 *
 * These exercise {@link createChatHandler} against fake, injectable
 * dependencies (no AWS, no real timers) and assert the HTTP-outcome mapping:
 * - success -> HTTP 200 with { response, sessionId, traceId } (Req 2.2)
 * - validation failure -> HTTP 400 without invoking the agent (Req 2.4)
 * - agent error -> HTTP 502 with a structured agent-failure error (Req 2.5)
 * - agent timeout -> HTTP 502 with a TIMEOUT-style error (Req 2.5)
 * - missing config -> CONFIG_ERROR without invoking the agent (Req 15.2)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryConfigSource, type StructuredError } from "@claimclarify/shared";
import {
  createChatHandler,
  AGENT_ID_CONFIG_KEY,
  AGENT_DEPENDENCY_NAME,
  type AgentInvoker,
  type ApiGatewayProxyResult,
} from "./handler";

/** Build a config source that holds the agent id the handler forwards to. */
function configWithAgent(agentId = "agent-123"): InMemoryConfigSource {
  return new InMemoryConfigSource({ [AGENT_ID_CONFIG_KEY]: agentId });
}

/** An AgentInvoker that always resolves with a fixed result. */
function resolvingInvoker(
  response = "Here is your triage summary.",
  sessionId = "session-abc"
): AgentInvoker {
  return {
    invoke: vi.fn().mockResolvedValue({ response, sessionId }),
  };
}

/** Build a well-formed request body for the happy path. */
function body(obj: unknown): string {
  return JSON.stringify(obj);
}

/** Parse the JSON body of a handler result. */
function parseBody(result: ApiGatewayProxyResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>;
}

/** Extract the StructuredError from an error-envelope response body. */
function errorOf(result: ApiGatewayProxyResult): StructuredError {
  return parseBody(result).error as StructuredError;
}

const FIXED_TRACE = "trace-fixed-0001";
const fixedTraceId = () => FIXED_TRACE;

describe("createChatHandler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("maps a successful invocation to HTTP 200 with response, sessionId, and traceId (Req 2.2)", async () => {
    const invoker = resolvingInvoker("Triage complete.", "sess-200");
    const handler = createChatHandler({
      configSource: configWithAgent("agent-xyz"),
      agentInvoker: invoker,
      createTraceId: fixedTraceId,
    });

    const result = await handler({ body: body({ message: "My car was hit." }) });

    expect(result.statusCode).toBe(200);
    expect(result.headers["Content-Type"]).toBe("application/json");
    expect(parseBody(result)).toEqual({
      response: "Triage complete.",
      sessionId: "sess-200",
      traceId: FIXED_TRACE,
    });

    // The agent received the validated request, trace id, and resolved agent id.
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
    expect(invoker.invoke).toHaveBeenCalledWith({
      request: { message: "My car was hit." },
      traceId: FIXED_TRACE,
      agentId: "agent-xyz",
    });
  });

  it("rejects an invalid request with HTTP 400 and never invokes the agent (Req 2.4)", async () => {
    const invoker = resolvingInvoker();
    const handler = createChatHandler({
      configSource: configWithAgent(),
      agentInvoker: invoker,
      createTraceId: fixedTraceId,
    });

    // Missing required `message` field.
    const result = await handler({ body: body({ sessionId: "s1" }) });

    expect(result.statusCode).toBe(400);
    const error = errorOf(result);
    expect(error.type).toBe("VALIDATION_ERROR");
    // The error names the violated constraint/field.
    expect(error.field).toBe("message");
    expect(error.message).toContain("message");
    expect(parseBody(result).traceId).toBe(FIXED_TRACE);

    // Crucially, the agent was never invoked for an invalid request.
    expect(invoker.invoke).not.toHaveBeenCalled();
  });

  it("maps an agent error to HTTP 502 with a structured agent-failure error (Req 2.5)", async () => {
    const invoker: AgentInvoker = {
      invoke: vi.fn().mockRejectedValue(new Error("bedrock exploded")),
    };
    const handler = createChatHandler({
      configSource: configWithAgent(),
      agentInvoker: invoker,
      createTraceId: fixedTraceId,
    });

    const result = await handler({ body: body({ message: "Help me." }) });

    expect(result.statusCode).toBe(502);
    const error = errorOf(result);
    expect(error.type).toBe("DEPENDENCY_ERROR");
    expect(error.dependency).toBe(AGENT_DEPENDENCY_NAME);
    expect(parseBody(result).traceId).toBe(FIXED_TRACE);
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it("maps an agent timeout to HTTP 502 with a TIMEOUT-style error (Req 2.5)", async () => {
    vi.useFakeTimers();
    // An invoker that never settles, so the handler's timeout wins the race.
    const invoker: AgentInvoker = {
      invoke: vi.fn().mockReturnValue(new Promise<never>(() => {})),
    };
    const handler = createChatHandler({
      configSource: configWithAgent(),
      agentInvoker: invoker,
      timeoutMs: 50,
      createTraceId: fixedTraceId,
    });

    const resultPromise = handler({ body: body({ message: "Still there?" }) });
    // Advance past the injected timeout to trigger the timeout branch.
    await vi.advanceTimersByTimeAsync(60);
    const result = await resultPromise;

    expect(result.statusCode).toBe(502);
    const error = errorOf(result);
    expect(error.type).toBe("TIMEOUT");
    expect(error.dependency).toBe(AGENT_DEPENDENCY_NAME);
    expect(parseBody(result).traceId).toBe(FIXED_TRACE);
    expect(invoker.invoke).toHaveBeenCalledTimes(1);
  });

  it("returns a CONFIG_ERROR without invoking the agent when the agent key is missing (Req 15.2)", async () => {
    const invoker = resolvingInvoker();
    const handler = createChatHandler({
      // Config_Store is read at runtime and does not contain the agent key.
      configSource: new InMemoryConfigSource({}),
      agentInvoker: invoker,
      createTraceId: fixedTraceId,
    });

    const result = await handler({ body: body({ message: "Valid message." }) });

    const error = errorOf(result);
    expect(error.type).toBe("CONFIG_ERROR");
    expect(error.message).toContain(AGENT_ID_CONFIG_KEY);
    expect(parseBody(result).traceId).toBe(FIXED_TRACE);

    // A config failure must short-circuit before the agent is invoked.
    expect(invoker.invoke).not.toHaveBeenCalled();
  });
});
