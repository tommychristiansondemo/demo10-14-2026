import { describe, it, expect } from "vitest";
import {
  createTraceId,
  withTraceId,
  propagateTraceId,
  type ToolInvocation,
} from "./index";

describe("createTraceId", () => {
  it("produces a well-formed UUID string", () => {
    const id = createTraceId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("produces a distinct id on each call", () => {
    const a = createTraceId();
    const b = createTraceId();
    expect(a).not.toEqual(b);
  });
});

describe("withTraceId", () => {
  it("stamps the traceId without mutating the input", () => {
    const payload = { message: "hello" };
    const stamped = withTraceId("trace-1", payload);
    expect(stamped).toEqual({ message: "hello", traceId: "trace-1" });
    expect(payload).not.toHaveProperty("traceId");
  });

  it("overwrites an existing traceId so the API-layer id wins", () => {
    const stamped = withTraceId("api-trace", {
      tool: "get_coverage",
      input: {},
      traceId: "stale",
    });
    expect(stamped.traceId).toBe("api-trace");
  });
});

describe("propagateTraceId", () => {
  it("stamps the identical traceId onto every tool invocation", () => {
    const traceId = createTraceId();
    const invocations: ToolInvocation[] = [
      { tool: "get_coverage", input: { policyId: "P1" } },
      { tool: "get_deductibles", input: { policyId: "P1" } },
      { tool: "estimate_repair", input: { vehicleYear: 2020 } },
    ];

    const emitted = propagateTraceId(traceId, invocations);

    expect(emitted).toHaveLength(invocations.length);
    expect(emitted.every((i) => i.traceId === traceId)).toBe(true);
    // order preserved
    expect(emitted.map((i) => i.tool)).toEqual([
      "get_coverage",
      "get_deductibles",
      "estimate_repair",
    ]);
  });

  it("returns an empty array for no invocations", () => {
    expect(propagateTraceId("t", [])).toEqual([]);
  });
});
