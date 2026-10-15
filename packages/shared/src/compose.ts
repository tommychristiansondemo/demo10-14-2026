/**
 * Bedrock_Agent response composition.
 *
 * Given the outcomes of the tool invocations the agent performed for a single
 * adjuster query, produce a natural-language response that incorporates every
 * successful tool result and explicitly names every tool that failed. This
 * covers the all-success case (Req 3.4), the all-failure case (Req 3.5), and
 * the partial-failure case where one tool succeeds and another fails (Req 3.6).
 *
 * See design.md "3. Bedrock_Agent" and
 * "Property 3: Agent response composition over mixed tool results".
 */

import { isStructuredError, type StructuredError } from "./errors";

/**
 * A successful tool invocation outcome: the tool's name plus its result
 * payload. The payload is intentionally `unknown` because different tools
 * return different shapes (coverage details, estimates, etc.); composition only
 * needs to render it, not interpret it.
 */
export interface ToolSuccess {
  tool: string;
  ok: true;
  result: unknown;
}

/**
 * A failed tool invocation outcome: the tool's name plus the structured error
 * describing why it failed (validation, dependency, timeout, etc.).
 */
export interface ToolFailure {
  tool: string;
  ok: false;
  error: StructuredError;
}

/**
 * The outcome of a single tool invocation performed by the agent: either a
 * success carrying a result payload, or a failure carrying a {@link StructuredError}.
 */
export type ToolOutcome = ToolSuccess | ToolFailure;

/** Type guard: is the given outcome a successful tool invocation? */
export function isToolSuccess(outcome: ToolOutcome): outcome is ToolSuccess {
  return outcome.ok === true;
}

/** Type guard: is the given outcome a failed tool invocation? */
export function isToolFailure(outcome: ToolOutcome): outcome is ToolFailure {
  return outcome.ok === false;
}

/**
 * Render a tool's success payload into a compact, human-readable fragment. The
 * exact wording is not important for correctness; what matters (Property 3) is
 * that the fragment references the tool and a representation of its result.
 */
function renderResult(result: unknown): string {
  if (result === null || result === undefined) {
    return "(no details returned)";
  }
  if (typeof result === "string") {
    return result;
  }
  if (
    typeof result === "number" ||
    typeof result === "boolean" ||
    typeof result === "bigint"
  ) {
    return String(result);
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/**
 * Compose a natural-language agent response from a set of tool outcomes.
 *
 * The composed text:
 * - references every successful tool by name together with a rendering of its
 *   result (Req 3.4), and
 * - explicitly names every failed tool together with its error message
 *   (Req 3.5), including when successes and failures are mixed in the same
 *   query (Req 3.6).
 *
 * The function is pure and deterministic: outcomes are rendered in the order
 * provided.
 *
 * @param toolOutcomes the outcomes of every tool the agent invoked for the query
 * @returns a natural-language response string
 */
export function composeResponse(toolOutcomes: readonly ToolOutcome[]): string {
  if (toolOutcomes.length === 0) {
    return "No tools were invoked for this query, so there are no results to report.";
  }

  const successes = toolOutcomes.filter(isToolSuccess);
  const failures = toolOutcomes.filter(isToolFailure);

  const sentences: string[] = [];

  for (const success of successes) {
    sentences.push(
      `The ${success.tool} tool returned: ${renderResult(success.result)}.`
    );
  }

  for (const failure of failures) {
    sentences.push(
      `The ${failure.tool} tool failed: ${failure.error.message} (${failure.error.type}).`
    );
  }

  return sentences.join(" ");
}

/**
 * Convenience helper to build a {@link ToolSuccess} outcome.
 */
export function toolSuccess(tool: string, result: unknown): ToolSuccess {
  return { tool, ok: true, result };
}

/**
 * Convenience helper to build a {@link ToolFailure} outcome. Accepts either a
 * {@link StructuredError} or a plain message (wrapped as a DEPENDENCY_ERROR).
 */
export function toolFailure(
  tool: string,
  error: StructuredError | string
): ToolFailure {
  if (isStructuredError(error)) {
    return { tool, ok: false, error };
  }
  return {
    tool,
    ok: false,
    error: { type: "DEPENDENCY_ERROR", dependency: tool, message: error },
  };
}
