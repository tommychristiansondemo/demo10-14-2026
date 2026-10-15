// @vitest-environment jsdom
/**
 * Unit / interaction tests for the Chat_UI (task 15.2).
 *
 * These exercise the {@link ChatController} view-model and its DOM projection
 * via {@link initChatUi} / {@link mountChatView} under jsdom, using a fake
 * `fetch` and (for the timeout path) Vitest fake timers so no real network or
 * wall-clock time is involved.
 *
 * The root Vitest environment is `node`; the per-file annotation above opts
 * this file into jsdom so a `document` and DOM APIs are available.
 *
 * Coverage: Req 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatController, DEFAULT_ENDPOINT, DEFAULT_TIMEOUT_MS } from "./chat-controller";
import { mountChatView, type ChatViewElements } from "./view";
import type { FetchLike, FetchResponseLike, TimerApi } from "./types";

/**
 * `./index` auto-boots when a `document` and `fetch` exist (the browser case).
 * Under jsdom those globals exist at import time, so we must (a) build the DOM
 * skeleton before importing it and (b) import it dynamically inside each test.
 * `importInitChatUi` resets the module registry and returns a fresh binding.
 */
async function importInitChatUi(): Promise<typeof import("./index").initChatUi> {
  vi.resetModules();
  const mod = await import("./index");
  return mod.initChatUi;
}

/**
 * Build the DOM skeleton the view expects (mirrors public/index.html) and
 * return the resolved elements plus a cleanup hook.
 */
function buildDom(): { doc: Document; elements: ChatViewElements } {
  document.body.innerHTML = `
    <main>
      <ul id="chat-history"></ul>
      <div id="chat-pending" hidden aria-hidden="true"></div>
      <p id="chat-error" hidden></p>
      <form id="chat-form">
        <textarea id="chat-input"></textarea>
        <button id="chat-submit" type="submit">Send</button>
      </form>
    </main>
  `;
  const byId = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as unknown as T;
  return {
    doc: document,
    elements: {
      form: byId<HTMLFormElement>("chat-form"),
      input: byId<HTMLTextAreaElement>("chat-input"),
      submit: byId<HTMLButtonElement>("chat-submit"),
      history: byId<HTMLElement>("chat-history"),
      pending: byId<HTMLElement>("chat-pending"),
      error: byId<HTMLElement>("chat-error"),
    },
  };
}

/** A JSON-returning fetch response double. */
function jsonResponse(
  status: number,
  body: unknown
): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** A fetch double that resolves immediately with the given response. */
function fetchReturning(response: FetchResponseLike): {
  fetchFn: FetchLike;
  calls: Array<{ url: string; init: Parameters<FetchLike>[1] }>;
} {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { fetchFn, calls };
}

/**
 * A fetch double whose resolution is controlled by the test. The returned
 * `resolve` lets a test keep the request in flight (to assert the pending
 * state) and then complete it.
 */
function deferredFetch(): {
  fetchFn: FetchLike;
  calls: Array<{ url: string; init: Parameters<FetchLike>[1] }>;
  resolve: (response: FetchResponseLike) => void;
  reject: (err: unknown) => void;
} {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  let resolveFn!: (response: FetchResponseLike) => void;
  let rejectFn!: (err: unknown) => void;
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, init });
    return new Promise<FetchResponseLike>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
  };
  return { fetchFn, calls, resolve: (r) => resolveFn(r), reject: (e) => rejectFn(e) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Chat_UI mount & presentation (Req 1.1)", () => {
  it("renders the input and history elements after mount", async () => {
    const { doc, elements } = buildDom();
    const { fetchFn } = fetchReturning(jsonResponse(200, { response: "hi" }));
    const initChatUi = await importInitChatUi();

    const { dispose } = initChatUi(doc, fetchFn);

    // Input field present and empty (accepts 1..2000 chars) and a history list.
    expect(elements.input).toBeTruthy();
    expect(elements.input.tagName.toLowerCase()).toBe("textarea");
    expect(elements.history).toBeTruthy();
    // History starts empty; pending indicator hidden; no error shown.
    expect(elements.history.children.length).toBe(0);
    expect(elements.pending.hidden).toBe(true);
    expect(elements.error.hidden).toBe(true);

    dispose();
  });
});

describe("Chat_UI submission (Req 1.2)", () => {
  it("fires a POST to /api/chat carrying the message", async () => {
    const { calls, fetchFn } = fetchReturning(
      jsonResponse(200, { response: "ok", sessionId: "s1", traceId: "t1" })
    );
    const controller = new ChatController({ fetch: fetchFn });

    await controller.submit("Is POL-100001 covered?");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DEFAULT_ENDPOINT);
    expect(calls[0].url).toBe("/api/chat");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual({ message: "Is POL-100001 covered?" });
  });

  it("does not send a request for an invalid (empty) message and retains the text (Req 1.3)", async () => {
    const { doc, elements } = buildDom();
    const { calls, fetchFn } = fetchReturning(jsonResponse(200, { response: "ok" }));
    const initChatUi = await importInitChatUi();
    const { controller, dispose } = initChatUi(doc, fetchFn);

    elements.input.value = ""; // empty -> rejected by client validation
    elements.form.dispatchEvent(new window.Event("submit", { cancelable: true }));
    // Let microtasks settle.
    await Promise.resolve();

    expect(calls).toHaveLength(0);
    // Entered text retained (still the empty string the user had typed).
    expect(elements.input.value).toBe("");
    // An allowed-range error is shown.
    expect(controller.getState().errorMessage).toMatch(/between 1 and 2000/i);
    expect(elements.error.hidden).toBe(false);

    dispose();
  });
});

describe("Chat_UI success rendering (Req 1.4)", () => {
  it("renders a successful response as a new history entry", async () => {
    const { doc, elements } = buildDom();
    const { fetchFn } = fetchReturning(
      jsonResponse(200, { response: "Policy POL-100001 is covered.", sessionId: "s1", traceId: "t1" })
    );
    const initChatUi = await importInitChatUi();
    const { controller, dispose } = initChatUi(doc, fetchFn);

    await controller.submit("Is POL-100001 covered?");
    // Allow the view subscription to re-render.
    await Promise.resolve();

    const state = controller.getState();
    // History holds the adjuster message plus the assistant response.
    expect(state.history).toHaveLength(2);
    expect(state.history[0]).toMatchObject({ role: "adjuster" });
    expect(state.history[1]).toMatchObject({
      role: "assistant",
      text: "Policy POL-100001 is covered.",
    });
    // DOM reflects both entries.
    expect(elements.history.children.length).toBe(2);
    expect(elements.history.textContent).toContain("Policy POL-100001 is covered.");

    dispose();
  });
});

describe("Chat_UI pending indicator (Req 1.5)", () => {
  it("shows the pending indicator while awaiting a response, then hides it", async () => {
    const { doc, elements } = buildDom();
    const deferred = deferredFetch();
    const initChatUi = await importInitChatUi();
    const { controller, dispose } = initChatUi(doc, deferred.fetchFn);

    const pendingPromise = controller.submit("hello");
    // While in flight: status pending, indicator visible, submit disabled.
    expect(controller.getState().status).toBe("pending");
    expect(elements.pending.hidden).toBe(false);
    expect(elements.submit.disabled).toBe(true);

    // Complete the request.
    deferred.resolve(jsonResponse(200, { response: "done", sessionId: "s", traceId: "t" }));
    await pendingPromise;
    await Promise.resolve();

    // Indicator removed once resolved.
    expect(controller.getState().status).toBe("idle");
    expect(elements.pending.hidden).toBe(true);
    expect(elements.submit.disabled).toBe(false);

    dispose();
  });
});

describe("Chat_UI 30s timeout (Req 1.6)", () => {
  it("removes the indicator and shows a timeout error after 30s, preserving history", async () => {
    vi.useFakeTimers();
    const { doc, elements } = buildDom();

    // A fetch that honours the AbortSignal: it rejects when aborted, so the
    // controller's timeout path (abort -> catch -> timeout) is exercised.
    const fetchFn: FetchLike = (_url, init) =>
      new Promise<FetchResponseLike>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      });

    // Use the real global timers wrapped so fake timers drive setTimeout.
    const timers: TimerApi = {
      setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown as number,
      clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
    };
    const controller = new ChatController({ fetch: fetchFn, timers });
    const dispose = mountChatView(controller, elements);

    const outcomePromise = controller.submit("will time out");
    // In flight before the timeout fires.
    expect(controller.getState().status).toBe("pending");
    expect(elements.pending.hidden).toBe(false);

    // Advance exactly to the 30s client timeout.
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    const outcome = await outcomePromise;

    expect(outcome.kind).toBe("timeout");
    const state = controller.getState();
    // Indicator removed, timeout error surfaced.
    expect(state.status).toBe("idle");
    expect(elements.pending.hidden).toBe(true);
    expect(state.errorMessage).toMatch(/timed out/i);
    expect(elements.error.hidden).toBe(false);
    // History preserved: the adjuster's message remains.
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ role: "adjuster", text: "will time out" });

    dispose();
  });
});

describe("Chat_UI error response (Req 1.7)", () => {
  it("preserves history and shows a failure-identifying message on a 502", async () => {
    const { doc, elements } = buildDom();
    // First a successful turn to establish prior history, then a 502.
    const responses: FetchResponseLike[] = [
      jsonResponse(200, { response: "first answer", sessionId: "s1", traceId: "t1" }),
      jsonResponse(502, {
        error: { code: "DEPENDENCY_ERROR", message: "agent unavailable" },
        traceId: "t2",
      }),
    ];
    let call = 0;
    const fetchFn: FetchLike = async () => responses[call++];

    const initChatUi = await importInitChatUi();
    const { controller, dispose } = initChatUi(doc, fetchFn);

    await controller.submit("first question");
    await Promise.resolve();
    const historyBefore = controller.getState().history.length; // 2 entries

    const outcome = await controller.submit("second question");
    await Promise.resolve();

    expect(outcome).toEqual({ kind: "error", status: 502 });
    const state = controller.getState();
    // Pending indicator removed.
    expect(state.status).toBe("idle");
    expect(elements.pending.hidden).toBe(true);
    // Failure-identifying message surfaced (names the failure / 502 reach).
    expect(state.errorMessage).toBeTruthy();
    expect(state.errorMessage).toMatch(/could not be reached|agent unavailable/i);
    expect(elements.error.hidden).toBe(false);
    // Existing history preserved; the failed turn still appended the adjuster
    // message but added no assistant entry.
    expect(state.history.length).toBeGreaterThanOrEqual(historyBefore);
    expect(state.history[0]).toMatchObject({ role: "adjuster", text: "first question" });
    expect(state.history[1]).toMatchObject({ role: "assistant", text: "first answer" });
    // No assistant entry was added for the failed turn.
    const assistantEntries = state.history.filter((e) => e.role === "assistant");
    expect(assistantEntries).toHaveLength(1);

    dispose();
  });
});
