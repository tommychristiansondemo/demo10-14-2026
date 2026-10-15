/**
 * ClaimClarify static Chat_UI entry point.
 *
 * Boots the single-page chat experience: locates the DOM elements declared in
 * `index.html`, constructs a {@link ChatController} backed by the browser's
 * `fetch` and global timers, and mounts the view (Req 1.1–1.7).
 *
 * The UI talks only to the same-origin `/api/chat` path, so no host or secret
 * is embedded in the client (design.md "1. Chat_UI").
 *
 * The controller/view API is re-exported so it can be reused and unit-tested
 * under jsdom (task 15.2).
 */

import { ChatController } from "./chat-controller";
import { mountChatView, type ChatViewElements } from "./view";
import type { FetchLike } from "./types";

export { ChatController, DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS } from "./chat-controller";
export type { StateListener, SubmitOutcome } from "./chat-controller";
export { mountChatView } from "./view";
export type { ChatViewElements } from "./view";
export type {
  ChatEntry,
  ChatState,
  ChatStatus,
  ChatRole,
  ChatControllerDeps,
  ChatSuccessBody,
  ChatErrorBody,
  FetchLike,
  FetchResponseLike,
  TimerApi,
} from "./types";

// Re-export the shared contracts for convenience to downstream consumers.
export type { ChatRequest, ChatResponse } from "@claimclarify/shared";

/**
 * Resolve the required DOM elements by id. Throws if the document is missing a
 * required element so wiring mistakes surface immediately at boot.
 */
function resolveElements(doc: Document): ChatViewElements {
  const byId = <T extends HTMLElement>(id: string): T => {
    const el = doc.getElementById(id);
    if (!el) {
      throw new Error(`Chat_UI: missing required element #${id}`);
    }
    return el as T;
  };

  return {
    form: byId<HTMLFormElement>("chat-form"),
    input: byId<HTMLTextAreaElement>("chat-input"),
    submit: byId<HTMLButtonElement>("chat-submit"),
    history: byId<HTMLElement>("chat-history"),
    pending: byId<HTMLElement>("chat-pending"),
    error: byId<HTMLElement>("chat-error"),
  };
}

/**
 * Initialize the Chat_UI against a document. Exposed for tests that supply a
 * jsdom document; the browser bootstrap calls it with the real `document`.
 */
export function initChatUi(
  doc: Document,
  fetchFn: FetchLike
): { controller: ChatController; dispose: () => void } {
  const controller = new ChatController({ fetch: fetchFn });
  const dispose = mountChatView(controller, resolveElements(doc));
  return { controller, dispose };
}

// Auto-boot in a browser context. Guarded so importing this module in Node
// (e.g. during unit tests) does not require a global document.
if (typeof document !== "undefined" && typeof fetch !== "undefined") {
  const start = (): void => {
    initChatUi(document, (input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
