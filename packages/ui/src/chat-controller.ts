/**
 * ChatController: the framework-free view-model that owns all Chat_UI logic
 * for Requirement 1 (Adjuster Chat Interaction).
 *
 * The controller is deliberately decoupled from the DOM and from browser
 * globals so it can be unit-tested under jsdom with a fake `fetch` and fake
 * timers (task 15.2). The view layer subscribes to {@link ChatState} changes
 * and projects them onto the DOM.
 *
 * Responsibilities (Req 1.1–1.7):
 * - Hold the conversation history and current status.
 * - Client-side validate message length via the shared `validateMessageLength`
 *   (Req 1.3), retaining the entered text on rejection.
 * - Submit valid messages over HTTPS to the same-origin `/api/chat` path via
 *   fetch, POSTing `{ message, sessionId? }` (Req 1.2).
 * - Show a pending indicator while awaiting a response (Req 1.5).
 * - Enforce a 30s client timeout that aborts the request, removes the
 *   indicator, and shows a timeout error (Req 1.6).
 * - Render a successful response as a new history entry (Req 1.4).
 * - On an error response, remove the indicator, show a failure-identifying
 *   message, and preserve the existing history (Req 1.7).
 */

// Import the pure validator from its specific module rather than the package
// barrel: the barrel re-exports server-only helpers (e.g. trace.ts, which pulls
// in `node:crypto`) that must not land in the browser bundle. This keeps the
// Chat_UI bundle free of Node built-ins while reusing the shared logic.
import { validateMessageLength } from "@claimclarify/shared/dist/validation";
import type {
  ChatControllerDeps,
  ChatEntry,
  ChatErrorBody,
  ChatState,
  ChatStatus,
  ChatSuccessBody,
  FetchLike,
  TimerApi,
} from "./types";

/** Same-origin API path. No host or secret is embedded (design.md "1. Chat_UI"). */
export const DEFAULT_ENDPOINT = "/api/chat";

/** Default client-side timeout window in milliseconds (Req 1.6). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** A listener notified with an immutable state snapshot after every change. */
export type StateListener = (state: ChatState) => void;

/**
 * The outcome of {@link ChatController.submit}, useful for tests and callers
 * that want to await completion. The UI itself reacts via state subscription.
 */
export type SubmitOutcome =
  | { kind: "rejected"; reason: "validation" }
  | { kind: "success" }
  | { kind: "error"; status: number }
  | { kind: "timeout" }
  | { kind: "network" };

/** Default timer API backed by the host environment's global timers. */
const globalTimers: TimerApi = {
  setTimeout: (handler, timeoutMs) =>
    setTimeout(handler, timeoutMs) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};

export class ChatController {
  private readonly fetchFn: FetchLike;
  private readonly timers: TimerApi;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  private history: ChatEntry[] = [];
  private status: ChatStatus = "idle";
  private errorMessage: string | null = null;
  private sessionId: string | null = null;

  private readonly listeners = new Set<StateListener>();

  constructor(deps: ChatControllerDeps) {
    this.fetchFn = deps.fetch;
    this.timers = deps.timers ?? globalTimers;
    this.endpoint = deps.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Current immutable state snapshot. */
  getState(): ChatState {
    return {
      history: this.history.slice(),
      status: this.status,
      errorMessage: this.errorMessage,
      sessionId: this.sessionId,
    };
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe function. The listener
   * is invoked immediately with the current snapshot so views render initial
   * state without special-casing.
   */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Validate and submit a message.
   *
   * The raw `input` is the current text in the input field. On a client-side
   * length rejection (Req 1.3), the controller sets an allowed-range error and
   * does NOT clear the input — the caller/view keeps the entered text — and no
   * request is sent. On acceptance, the adjuster entry is appended, the pending
   * indicator is shown (Req 1.5), and a POST is issued to `/api/chat` (Req 1.2).
   *
   * @returns a {@link SubmitOutcome} describing the result.
   */
  async submit(input: string): Promise<SubmitOutcome> {
    // Ignore concurrent submits while a request is already in flight.
    if (this.status === "pending") {
      return { kind: "rejected", reason: "validation" };
    }

    // Client-side length validation reusing the shared validator (Req 1.3).
    const check = validateMessageLength(input);
    if (!check.accepted) {
      // Show the allowed-range error; retain the entered text (do not clear).
      this.errorMessage = check.error.message;
      this.emit();
      return { kind: "rejected", reason: "validation" };
    }

    // Accepted: clear any prior error, record the adjuster's message, and show
    // the pending indicator (Req 1.4 history growth, Req 1.5 indicator).
    this.errorMessage = null;
    this.appendEntry({ role: "adjuster", text: input });
    this.status = "pending";
    this.emit();

    return this.dispatch(input);
  }

  /**
   * Issue the HTTP request with a client-side timeout.
   *
   * Uses an AbortController plus a timer so that if no response or error
   * arrives within {@link timeoutMs} the request is aborted, the indicator is
   * removed, and a timeout error is shown (Req 1.6).
   */
  private async dispatch(message: string): Promise<SubmitOutcome> {
    const controller = new AbortController();
    let timedOut = false;

    const timer = this.timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const body = JSON.stringify(
      this.sessionId ? { message, sessionId: this.sessionId } : { message }
    );

    try {
      const res = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      this.timers.clearTimeout(timer);

      if (res.ok) {
        return await this.handleSuccess(res);
      }
      return await this.handleErrorResponse(res);
    } catch (err) {
      this.timers.clearTimeout(timer);
      if (timedOut) {
        return this.handleTimeout();
      }
      return this.handleNetworkError(err);
    }
  }

  /** Render a successful response as a new history entry (Req 1.4). */
  private async handleSuccess(res: {
    json(): Promise<unknown>;
  }): Promise<SubmitOutcome> {
    let payload: Partial<ChatSuccessBody> = {};
    try {
      payload = (await res.json()) as Partial<ChatSuccessBody>;
    } catch {
      // A 200 with an unparseable body is treated as a failure (Req 1.7).
      this.finishWithError("The server returned an unreadable response.");
      return { kind: "error", status: 200 };
    }

    const text =
      typeof payload.response === "string" && payload.response.length > 0
        ? payload.response
        : "The server returned an empty response.";

    if (typeof payload.sessionId === "string") {
      this.sessionId = payload.sessionId;
    }

    this.status = "idle";
    this.errorMessage = null;
    this.appendEntry({
      role: "assistant",
      text,
      traceId: typeof payload.traceId === "string" ? payload.traceId : undefined,
    });
    this.emit();
    return { kind: "success" };
  }

  /**
   * On an API error response (HTTP 400/502/etc.): remove the pending
   * indicator, show a failure-identifying message, and preserve the existing
   * conversation history (Req 1.7).
   */
  private async handleErrorResponse(res: {
    status: number;
    json(): Promise<unknown>;
  }): Promise<SubmitOutcome> {
    let detail: string | undefined;
    let traceId: string | undefined;
    try {
      const payload = (await res.json()) as ChatErrorBody;
      if (payload && payload.error) {
        detail = payload.error.message;
      }
      if (payload && typeof payload.traceId === "string") {
        traceId = payload.traceId;
      }
    } catch {
      // Ignore body parse failures; fall back to a status-based message.
    }

    const message = this.describeFailure(res.status, detail);
    this.finishWithError(message, traceId);
    return { kind: "error", status: res.status };
  }

  /** Handle the 30s client timeout path (Req 1.6). */
  private handleTimeout(): SubmitOutcome {
    this.finishWithError(
      `The request timed out after ${Math.round(
        this.timeoutMs / 1000
      )} seconds. Please try again.`
    );
    return { kind: "timeout" };
  }

  /** Handle a transport-level failure (DNS, offline, aborted non-timeout). */
  private handleNetworkError(err: unknown): SubmitOutcome {
    const reason = err instanceof Error && err.message ? err.message : "a network error";
    this.finishWithError(`The request failed due to ${reason}.`);
    return { kind: "network" };
  }

  /**
   * Common terminal-failure path: drop the pending indicator, set a
   * failure-identifying message, and leave history untouched (Req 1.6, 1.7).
   */
  private finishWithError(message: string, traceId?: string): void {
    this.status = "idle";
    this.errorMessage = traceId ? `${message} (trace ${traceId})` : message;
    this.emit();
  }

  /** Compose a human-readable, failure-identifying message by status. */
  private describeFailure(status: number, detail?: string): string {
    const base =
      status === 400
        ? "The request was rejected as invalid"
        : status === 502
        ? "The assistant could not be reached"
        : `The server responded with an error (HTTP ${status})`;
    return detail ? `${base}: ${detail}` : `${base}.`;
  }

  private appendEntry(entry: ChatEntry): void {
    this.history = [...this.history, entry];
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
