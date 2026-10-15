/**
 * ClaimClarify API_Layer Chat Handler Lambda.
 *
 * Wires together the pure, already-built shared pieces (request validation,
 * runtime config loading, trace-id creation, and dependency-error
 * normalization) into an API Gateway proxy handler that forwards a validated
 * chat request to the Bedrock_Agent and maps the outcome to an HTTP response.
 *
 * Behavior (design.md "2. API_Layer"):
 * - Create a fresh `traceId` per request (Req 12.5).
 * - Validate the request body before invoking the agent; on failure return
 *   HTTP 400 naming the violated constraint, without invoking the agent
 *   (Req 2.4, 13.1, 13.4).
 * - Load required configuration from a {@link ConfigSource}; if unavailable
 *   return a CONFIG_ERROR response with no embedded fallback (Req 15.2, 15.3).
 * - Invoke the Bedrock_Agent via an injectable {@link AgentInvoker}, applying a
 *   25-second agent-invocation timeout (Req 2.1, 2.5).
 * - On success return HTTP 200 with `{ response, sessionId, traceId }`
 *   (Req 2.2).
 * - On agent failure or timeout return HTTP 502 with a structured
 *   agent-failure error and the `traceId` (Req 2.5, 13.5).
 *
 * Dependencies ({@link ConfigSource}, {@link AgentInvoker}, timeout, and clock)
 * are injectable so the handler is unit-testable without AWS (task 11.2).
 */

import {
  type ConfigSource,
  type ChatRequest,
  type ChatResponse,
  type StructuredError,
  loadConfig,
  validateChatRequest,
  createTraceId,
  normalizeDependencyError,
} from "@claimclarify/shared";

/** Default agent-invocation timeout in milliseconds (Req 2.5). */
export const AGENT_INVOCATION_TIMEOUT_MS = 25_000;

/** The name used for the Bedrock_Agent dependency in structured errors. */
export const AGENT_DEPENDENCY_NAME = "Bedrock_Agent";

/**
 * Config_Store key for the Bedrock agent identifier the handler forwards to.
 * Retrieved at runtime; the handler never embeds a fallback value (Req 15.3).
 */
export const AGENT_ID_CONFIG_KEY = "BEDROCK_AGENT_ID";

/**
 * Minimal API Gateway proxy event shape consumed by the handler. Only the
 * fields the handler reads are modeled so unit tests can construct events
 * without pulling in `@types/aws-lambda`.
 */
export interface ApiGatewayProxyEvent {
  /** Raw request body as a JSON string (API Gateway proxy integration). */
  body: string | null;
  /** Whether `body` is base64-encoded. */
  isBase64Encoded?: boolean;
}

/**
 * Minimal API Gateway proxy result shape returned by the handler.
 */
export interface ApiGatewayProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * The result of a Bedrock_Agent invocation performed by an {@link AgentInvoker}.
 */
export interface AgentResult {
  /** The composed natural-language response for the adjuster. */
  response: string;
  /** The (possibly newly created) conversation session id. */
  sessionId: string;
}

/**
 * Arguments passed to an {@link AgentInvoker}. Carries the validated request,
 * the shared `traceId`, and the resolved agent identifier from config.
 */
export interface AgentInvocation {
  request: ChatRequest;
  traceId: string;
  agentId: string;
}

/**
 * Injectable interface for invoking the Bedrock_Agent. A production adapter
 * wraps the AWS Bedrock Agent Runtime client; tests supply a fake. The handler
 * owns the timeout, so an invoker is expected to run to completion or reject.
 */
export interface AgentInvoker {
  invoke(invocation: AgentInvocation): Promise<AgentResult>;
}

/**
 * Dependencies injected into {@link createChatHandler}. All are explicit so the
 * handler can be exercised in unit tests without AWS or real timers.
 */
export interface ChatHandlerDeps {
  /** Config_Store abstraction the handler reads required config from. */
  configSource: ConfigSource;
  /** Injectable Bedrock_Agent invoker. */
  agentInvoker: AgentInvoker;
  /** Agent-invocation timeout in milliseconds. Defaults to 25s (Req 2.5). */
  timeoutMs?: number;
  /** Trace-id factory. Defaults to {@link createTraceId}; overridable in tests. */
  createTraceId?: () => string;
}

/** JSON `Content-Type` header applied to every response. */
const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

/** The structured error envelope returned on the wire. */
interface ErrorEnvelope {
  error: StructuredError;
  traceId: string;
}

/** Build a JSON API Gateway proxy result. */
function jsonResponse(statusCode: number, payload: unknown): ApiGatewayProxyResult {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  };
}

/** Build an error response wrapping a {@link StructuredError} and the traceId. */
function errorResponse(
  statusCode: number,
  error: StructuredError,
  traceId: string
): ApiGatewayProxyResult {
  const envelope: ErrorEnvelope = { error, traceId };
  return jsonResponse(statusCode, envelope);
}

/**
 * A promise that rejects with a sentinel once `timeoutMs` elapses, used to race
 * the agent invocation. The timer is cleared when the race settles so the
 * Lambda does not stay alive waiting on it.
 */
const TIMEOUT_SENTINEL = Symbol("agent-invocation-timeout");

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ timedOut: true });
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (err === TIMEOUT_SENTINEL) {
          resolve({ timedOut: true });
          return;
        }
        reject(err);
      }
    );
  });
}

/**
 * Decode the raw request body from an API Gateway proxy event, honoring the
 * `isBase64Encoded` flag. Returns the body as a string (empty string when
 * absent) so downstream validation reports a structured error rather than
 * throwing.
 */
function readBody(event: ApiGatewayProxyEvent): string {
  const raw = event.body ?? "";
  if (event.isBase64Encoded && raw.length > 0) {
    return Buffer.from(raw, "base64").toString("utf8");
  }
  return raw;
}

/**
 * Create the API_Layer chat handler with its dependencies bound.
 *
 * The returned function accepts an API Gateway proxy event and resolves to an
 * API Gateway proxy result, never throwing: every failure path maps to a
 * structured error response carrying the shared `traceId`.
 */
export function createChatHandler(deps: ChatHandlerDeps) {
  const {
    configSource,
    agentInvoker,
    timeoutMs = AGENT_INVOCATION_TIMEOUT_MS,
    createTraceId: traceIdFactory = createTraceId,
  } = deps;

  return async function chatHandler(
    event: ApiGatewayProxyEvent
  ): Promise<ApiGatewayProxyResult> {
    // A fresh trace id per request, propagated to the agent and every error
    // response for cross-layer correlation (Req 12.5).
    const traceId = traceIdFactory();

    // Validate the request body before touching the agent. On failure, return
    // HTTP 400 naming the violated constraint without invoking the agent
    // (Req 2.4, 13.1, 13.4).
    const validation = validateChatRequest(readBody(event));
    if (!validation.accepted) {
      return errorResponse(400, validation.error, traceId);
    }

    // Load required configuration at runtime from the Config_Store. A missing
    // key yields CONFIG_ERROR with no embedded fallback (Req 15.2, 15.3).
    const configResult = loadConfig(configSource, AGENT_ID_CONFIG_KEY);
    if (!configResult.ok) {
      return errorResponse(502, configResult.error, traceId);
    }

    // Invoke the Bedrock_Agent via the injectable invoker, bounded by the
    // 25-second agent-invocation timeout (Req 2.1, 2.5).
    const invocation: AgentInvocation = {
      request: validation.request,
      traceId,
      agentId: configResult.value,
    };

    let outcome: { timedOut: false; value: AgentResult } | { timedOut: true };
    try {
      outcome = await withTimeout(agentInvoker.invoke(invocation), timeoutMs);
    } catch (cause) {
      // Agent invocation failed: normalize to a DEPENDENCY_ERROR naming the
      // agent and return HTTP 502 (Req 2.5, 13.5).
      const error = normalizeDependencyError(
        AGENT_DEPENDENCY_NAME,
        { cause },
        traceId
      );
      return errorResponse(502, error, traceId);
    }

    if (outcome.timedOut) {
      // Agent did not return within 25s: normalize to a TIMEOUT dependency
      // error and return HTTP 502 (Req 2.5, 13.5).
      const error = normalizeDependencyError(
        AGENT_DEPENDENCY_NAME,
        { timeout: true },
        traceId
      );
      return errorResponse(502, error, traceId);
    }

    // Success: map the agent result to the HTTP 200 chat response (Req 2.2).
    const response: ChatResponse = {
      response: outcome.value.response,
      sessionId: outcome.value.sessionId,
      traceId,
    };
    return jsonResponse(200, response);
  };
}

/** The handler function type produced by {@link createChatHandler}. */
export type ChatHandler = ReturnType<typeof createChatHandler>;
