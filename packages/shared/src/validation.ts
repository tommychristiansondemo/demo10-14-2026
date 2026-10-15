/**
 * Pure input-validation logic shared across ClaimClarify components.
 *
 * These functions contain no AWS I/O and are safe to reuse in the Chat_UI
 * (client-side length checks) and the API_Layer (request schema/size checks).
 *
 * See design.md "2. API_Layer" and the Error Handling table (Req 1.3, 2.3,
 * 2.4, 13.1, 13.4).
 */

import {
  MESSAGE_MAX_LENGTH,
  MESSAGE_MIN_LENGTH,
  MAX_PAYLOAD_BYTES,
  type ChatRequest,
} from "./chat";
import type { StructuredError } from "./errors";

/**
 * Result of {@link validateMessageLength}.
 *
 * On acceptance, `retainInput` is omitted. On rejection, `retainInput` is
 * `true` to signal the Chat_UI to keep the entered text in the input field
 * (Req 1.3), and `error` carries a VALIDATION_ERROR describing the allowed
 * range.
 */
export type MessageLengthResult =
  | { accepted: true }
  | { accepted: false; error: StructuredError; retainInput: true };

/**
 * Result of {@link validateChatRequest}.
 *
 * On acceptance, the narrowed {@link ChatRequest} is returned. On rejection,
 * `error` is a VALIDATION_ERROR naming the violated constraint/field (Req 2.4,
 * 13.4) so the API_Layer can return HTTP 400 without invoking the agent.
 */
export type ChatRequestResult =
  | { accepted: true; request: ChatRequest }
  | { accepted: false; error: StructuredError };

/** Human-readable description of the allowed message length range. */
const ALLOWED_RANGE_MESSAGE = `Message must be between ${MESSAGE_MIN_LENGTH} and ${MESSAGE_MAX_LENGTH} characters.`;

/**
 * Validate a chat message's length for client-side submission (Req 1.3).
 *
 * Accepts the input if and only if its character length is within
 * `[MESSAGE_MIN_LENGTH, MESSAGE_MAX_LENGTH]` inclusive. On rejection, returns a
 * VALIDATION_ERROR naming the `message` field and the allowed range, and sets
 * `retainInput` so the UI keeps the entered text.
 *
 * Length is measured in UTF-16 code units (JavaScript's `String#length`),
 * matching the browser input element's own length accounting.
 */
export function validateMessageLength(input: string): MessageLengthResult {
  const length = input.length;
  if (length >= MESSAGE_MIN_LENGTH && length <= MESSAGE_MAX_LENGTH) {
    return { accepted: true };
  }
  return {
    accepted: false,
    retainInput: true,
    error: {
      type: "VALIDATION_ERROR",
      field: "message",
      message: ALLOWED_RANGE_MESSAGE,
    },
  };
}

/**
 * Compute the byte size of a request body for payload-size validation.
 *
 * When given a string (the raw request body), measures its UTF-8 byte length.
 * When given a non-string value (an already-parsed object), serializes it to
 * JSON first so the size reflects the on-the-wire representation.
 */
function payloadByteSize(body: unknown): number {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  // `serialized` can be undefined if JSON.stringify is given e.g. a function;
  // such bodies are rejected earlier by shape checks, but guard anyway.
  if (typeof serialized !== "string") {
    return 0;
  }
  return byteLength(serialized);
}

/** UTF-8 byte length of a string, without depending on Node's Buffer. */
function byteLength(value: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  // Fallback for environments without TextEncoder.
  return unescape(encodeURIComponent(value)).length;
}

/**
 * Validate an incoming chat request body against the API_Layer schema and size
 * limits before the Bedrock_Agent is invoked (Req 2.3, 2.4, 13.1, 13.4).
 *
 * Accepts the body if and only if all of the following hold:
 * - the body is a JSON object (not null, array, or primitive);
 * - `message` is present and is a string;
 * - `message` is non-empty (length >= 1);
 * - `message` length is <= {@link MESSAGE_MAX_LENGTH};
 * - the optional `sessionId`, if present, is a string;
 * - the total payload size is <= {@link MAX_PAYLOAD_BYTES} (1 MB).
 *
 * On any failure, returns a VALIDATION_ERROR naming the violated
 * constraint/field so the caller can return HTTP 400 without invoking the
 * agent. Checks are ordered so the most specific/structural failure is
 * reported first.
 *
 * @param body The request body. May be the raw JSON string or an already
 *   parsed value.
 */
export function validateChatRequest(body: unknown): ChatRequestResult {
  // Enforce the overall payload-size ceiling first so an oversized body is
  // rejected regardless of its shape (Req 2.3).
  if (payloadByteSize(body) > MAX_PAYLOAD_BYTES) {
    return reject(
      "payload",
      `Request payload exceeds the maximum allowed size of ${MAX_PAYLOAD_BYTES} bytes.`
    );
  }

  // Parse raw string bodies into a value for shape validation (Req 13.1).
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return reject("body", "Request body is not valid JSON.");
    }
  }

  // The body must be a plain JSON object (Req 2.3 "conforms to the schema").
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return reject("body", "Request body must be a JSON object.");
  }

  const candidate = parsed as Record<string, unknown>;

  // `message` must be present and a string.
  if (!("message" in candidate) || typeof candidate.message !== "string") {
    return reject("message", "Field 'message' is required and must be a string.");
  }

  const message = candidate.message;

  // `message` must be non-empty (Req 2.3).
  if (message.length < MESSAGE_MIN_LENGTH) {
    return reject("message", "Field 'message' must not be empty.");
  }

  // `message` length must be within the maximum (Req 2.3).
  if (message.length > MESSAGE_MAX_LENGTH) {
    return reject(
      "message",
      `Field 'message' must be at most ${MESSAGE_MAX_LENGTH} characters.`
    );
  }

  // Optional `sessionId`, if present, must be a string.
  if ("sessionId" in candidate && candidate.sessionId !== undefined) {
    if (typeof candidate.sessionId !== "string") {
      return reject("sessionId", "Field 'sessionId' must be a string when provided.");
    }
  }

  const request: ChatRequest = { message };
  if (typeof candidate.sessionId === "string") {
    request.sessionId = candidate.sessionId;
  }

  return { accepted: true, request };
}

/** Build a rejected {@link ChatRequestResult} with a VALIDATION_ERROR. */
function reject(field: string, message: string): ChatRequestResult {
  return {
    accepted: false,
    error: { type: "VALIDATION_ERROR", field, message },
  };
}
