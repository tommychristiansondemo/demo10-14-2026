/**
 * Types for the ClaimClarify Chat_UI view-model.
 *
 * These describe the conversation state and the pluggable dependencies
 * (fetch + timers) that make the {@link ChatController} unit-testable under
 * jsdom without touching real network or wall-clock time.
 */

import type { StructuredError } from "@claimclarify/shared";

/** The author of a conversation entry. */
export type ChatRole = "adjuster" | "assistant" | "error";

/** A single rendered entry in the conversation history (Req 1.1, 1.4). */
export interface ChatEntry {
  /** Who produced the entry. */
  role: ChatRole;
  /** The displayed text. */
  text: string;
  /** Optional trace id associated with an assistant/error entry. */
  traceId?: string;
}

/**
 * The success body returned by `POST /api/chat` (design.md "2. API_Layer").
 */
export interface ChatSuccessBody {
  response: string;
  sessionId: string;
  traceId: string;
}

/**
 * The error body returned by `POST /api/chat` on 400/502 (design.md
 * "2. API_Layer"). The API layer uses `code`; the shared StructuredError uses
 * `type`. We accept either so the UI can surface a failure-identifying message.
 */
export interface ChatErrorBody {
  error: {
    code?: string;
    type?: StructuredError["type"];
    message?: string;
    field?: string;
  };
  traceId?: string;
}

/**
 * The pending status of the controller. `idle` means no request is in flight;
 * `pending` means a request is awaiting a response and the pending indicator
 * should be shown (Req 1.5).
 */
export type ChatStatus = "idle" | "pending";

/**
 * Observable state the view renders from. The controller is the single source
 * of truth; the view is a pure projection of this snapshot.
 */
export interface ChatState {
  /** The full conversation history, oldest first. */
  readonly history: ReadonlyArray<ChatEntry>;
  /** Current pending status (drives the pending indicator). */
  readonly status: ChatStatus;
  /** Current validation/error message to display, or null when none. */
  readonly errorMessage: string | null;
  /** The session id returned by the API, threaded into subsequent requests. */
  readonly sessionId: string | null;
}

/**
 * A minimal fetch signature. Injected so tests can supply a fake instead of
 * the browser's global `fetch`.
 */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponseLike>;

/** The subset of the Fetch `Response` the controller relies on. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Timer primitives, injected so tests can drive the 30s client timeout with
 * fake timers deterministically (Req 1.6).
 */
export interface TimerApi {
  setTimeout(handler: () => void, timeoutMs: number): number;
  clearTimeout(handle: number): void;
}

/** Dependencies the {@link ChatController} needs; all injectable for tests. */
export interface ChatControllerDeps {
  /** The HTTP transport. Defaults to the global `fetch` in the browser. */
  fetch: FetchLike;
  /** Timer API. Defaults to the global timers in the browser. */
  timers?: TimerApi;
  /** Same-origin API path. Fixed to `/api/chat`; no secrets embedded. */
  endpoint?: string;
  /** Client timeout in milliseconds (Req 1.6). Defaults to 30000. */
  timeoutMs?: number;
}
