import { describe, it, expect } from "vitest";
import {
  validateMessageLength,
  validateChatRequest,
  MESSAGE_MAX_LENGTH,
  MAX_PAYLOAD_BYTES,
} from "./index";

describe("validateMessageLength (Req 1.3)", () => {
  it("accepts a single-character message (lower boundary)", () => {
    expect(validateMessageLength("a")).toEqual({ accepted: true });
  });

  it("accepts a message at the maximum length (upper boundary)", () => {
    expect(validateMessageLength("x".repeat(MESSAGE_MAX_LENGTH))).toEqual({
      accepted: true,
    });
  });

  it("rejects an empty message and signals the UI to retain input", () => {
    const result = validateMessageLength("");
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.retainInput).toBe(true);
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe("message");
    }
  });

  it("rejects a message exceeding the maximum length", () => {
    const result = validateMessageLength("x".repeat(MESSAGE_MAX_LENGTH + 1));
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.retainInput).toBe(true);
      expect(result.error.type).toBe("VALIDATION_ERROR");
    }
  });
});

describe("validateChatRequest (Req 2.3, 2.4, 13.1, 13.4)", () => {
  it("accepts a well-formed object body", () => {
    const result = validateChatRequest({ message: "hello" });
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.request.message).toBe("hello");
    }
  });

  it("accepts a well-formed raw JSON string body with sessionId", () => {
    const result = validateChatRequest(
      JSON.stringify({ message: "hi", sessionId: "s-1" })
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.request.sessionId).toBe("s-1");
    }
  });

  it("rejects invalid JSON string with a VALIDATION_ERROR on the body", () => {
    const result = validateChatRequest("{not json");
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe("body");
    }
  });

  it("rejects a non-object body (array)", () => {
    const result = validateChatRequest([1, 2, 3]);
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.field).toBe("body");
    }
  });

  it("rejects a missing message field", () => {
    const result = validateChatRequest({ sessionId: "s-1" });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.field).toBe("message");
    }
  });

  it("rejects an empty message", () => {
    const result = validateChatRequest({ message: "" });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.field).toBe("message");
    }
  });

  it("rejects an overlong message", () => {
    const result = validateChatRequest({
      message: "x".repeat(MESSAGE_MAX_LENGTH + 1),
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.field).toBe("message");
    }
  });

  it("rejects a non-string sessionId", () => {
    const result = validateChatRequest({ message: "hi", sessionId: 42 });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.field).toBe("sessionId");
    }
  });

  it("rejects an oversized payload naming the payload constraint", () => {
    const big = "x".repeat(MAX_PAYLOAD_BYTES + 1);
    const result = validateChatRequest({ message: big });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.error.type).toBe("VALIDATION_ERROR");
      expect(result.error.field).toBe("payload");
    }
  });
});
