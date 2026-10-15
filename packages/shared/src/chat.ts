/**
 * API_Layer chat request/response contracts.
 *
 * See design.md "2. API_Layer (API Gateway + Chat Handler Lambda)".
 */

/** Minimum allowed chat message length (Req 1.1, 2.3). */
export const MESSAGE_MIN_LENGTH = 1;
/** Maximum allowed chat message length (Req 1.1, 2.3). */
export const MESSAGE_MAX_LENGTH = 2000;
/** Maximum allowed total request payload size in bytes (1 MB) (Req 2.3). */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * A chat request sent from the Chat_UI to the API_Layer.
 * `message` must be 1..2000 characters; `sessionId` is optional.
 */
export interface ChatRequest {
  message: string;
  sessionId?: string;
}

/**
 * A successful chat response returned by the API_Layer (HTTP 200).
 */
export interface ChatResponse {
  response: string;
  sessionId: string;
  traceId: string;
}
