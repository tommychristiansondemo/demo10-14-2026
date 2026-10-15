import { describe, it, expect } from "vitest";
import { classifyPath, API_PATH_PREFIX } from "./routing";

describe("classifyPath", () => {
  it("exposes the API prefix constant", () => {
    expect(API_PATH_PREFIX).toBe("/api/");
  });

  it("routes /api/* paths to the API behavior", () => {
    expect(classifyPath("/api/chat")).toBe("API");
    expect(classifyPath("/api/")).toBe("API");
    expect(classifyPath("/api/v1/policies/123")).toBe("API");
  });

  it("routes non-API paths to the S3_Origin behavior", () => {
    expect(classifyPath("/")).toBe("S3_ORIGIN");
    expect(classifyPath("/index.html")).toBe("S3_ORIGIN");
    expect(classifyPath("/assets/app.js")).toBe("S3_ORIGIN");
  });

  it("does not match the bare /api path (no trailing slash)", () => {
    expect(classifyPath("/api")).toBe("S3_ORIGIN");
  });

  it("does not match paths that merely contain /api/ later", () => {
    expect(classifyPath("/static/api/thing")).toBe("S3_ORIGIN");
  });
});
