/**
 * ClaimClarify API chat handler Lambda.
 *
 * Exposes the injectable chat handler factory and its supporting interfaces,
 * plus the shared request/response/error contracts.
 */
export {
  createChatHandler,
  AGENT_INVOCATION_TIMEOUT_MS,
  AGENT_DEPENDENCY_NAME,
  AGENT_ID_CONFIG_KEY,
  type ApiGatewayProxyEvent,
  type ApiGatewayProxyResult,
  type AgentResult,
  type AgentInvocation,
  type AgentInvoker,
  type ChatHandlerDeps,
  type ChatHandler,
} from "./handler";

export type { ChatRequest, ChatResponse, StructuredError } from "@claimclarify/shared";
