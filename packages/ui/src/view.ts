/**
 * DOM view for the Chat_UI.
 *
 * `mountChatView` wires DOM elements to a {@link ChatController}: it renders
 * the conversation history, the pending indicator, and error messages from the
 * controller's state (Req 1.1, 1.4, 1.5, 1.6, 1.7), and forwards submit events
 * to the controller (Req 1.2, 1.3).
 *
 * The view is a thin, declarative projection of {@link ChatState}; all behavior
 * and timing live in the controller so they can be tested without the DOM.
 */

import type { ChatController } from "./chat-controller";
import type { ChatEntry, ChatState } from "./types";

/** The DOM elements the view manages. */
export interface ChatViewElements {
  /** The `<form>` wrapping the input and submit control. */
  form: HTMLFormElement;
  /** The text input the adjuster types into (Req 1.1). */
  input: HTMLTextAreaElement | HTMLInputElement;
  /** The submit button; disabled while a request is pending. */
  submit: HTMLButtonElement;
  /** The container that lists conversation entries (Req 1.1, 1.4). */
  history: HTMLElement;
  /** The pending-response indicator element (Req 1.5). */
  pending: HTMLElement;
  /** The error/validation message element (Req 1.3, 1.6, 1.7). */
  error: HTMLElement;
}

/**
 * Bind the controller to the given elements. Returns a dispose function that
 * removes the state subscription and the submit listener.
 */
export function mountChatView(
  controller: ChatController,
  elements: ChatViewElements
): () => void {
  const { form, input, submit, history, pending, error } = elements;

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    void handleSubmit();
  };

  async function handleSubmit(): Promise<void> {
    const outcome = await controller.submit(input.value);
    // On acceptance (anything other than a validation rejection) the message
    // was consumed, so clear the input. On a validation rejection the entered
    // text is retained in the field (Req 1.3).
    if (outcome.kind !== "rejected") {
      input.value = "";
    }
  }

  form.addEventListener("submit", onSubmit);

  const unsubscribe = controller.subscribe((state) => {
    render(state, { history, pending, error, submit, input });
  });

  return () => {
    unsubscribe();
    form.removeEventListener("submit", onSubmit);
  };
}

/** Project a {@link ChatState} snapshot onto the DOM. */
function render(
  state: ChatState,
  els: {
    history: HTMLElement;
    pending: HTMLElement;
    error: HTMLElement;
    submit: HTMLButtonElement;
    input: HTMLTextAreaElement | HTMLInputElement;
  }
): void {
  renderHistory(state.history, els.history);

  const isPending = state.status === "pending";
  // Pending indicator visibility (Req 1.5 / removed in 1.6, 1.7).
  els.pending.hidden = !isPending;
  els.pending.setAttribute("aria-hidden", String(!isPending));

  // Disable the submit control and input while a request is in flight.
  els.submit.disabled = isPending;
  els.input.toggleAttribute("disabled", isPending);

  // Error / validation message (Req 1.3, 1.6, 1.7).
  if (state.errorMessage) {
    els.error.textContent = state.errorMessage;
    els.error.hidden = false;
  } else {
    els.error.textContent = "";
    els.error.hidden = true;
  }
}

/** Rebuild the conversation history list from the entries. */
function renderHistory(entries: ReadonlyArray<ChatEntry>, container: HTMLElement): void {
  // Simple, deterministic re-render: clear and rebuild. The lists are short
  // (an adjuster conversation), so this keeps the view logic trivial to reason
  // about and test.
  container.textContent = "";
  const doc = container.ownerDocument;
  for (const entry of entries) {
    const item = doc.createElement("li");
    item.className = `chat-entry chat-entry--${entry.role}`;
    item.dataset.role = entry.role;

    const author = doc.createElement("span");
    author.className = "chat-entry__author";
    author.textContent = authorLabel(entry.role);

    const body = doc.createElement("span");
    body.className = "chat-entry__text";
    body.textContent = entry.text;

    item.append(author, body);
    container.append(item);
  }
}

/** Human-readable label for an entry's role. */
function authorLabel(role: ChatEntry["role"]): string {
  switch (role) {
    case "adjuster":
      return "You";
    case "assistant":
      return "ClaimClarify";
    case "error":
      return "Error";
    default:
      return role;
  }
}
