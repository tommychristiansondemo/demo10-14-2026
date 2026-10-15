import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Single-run by default (CI friendly); `vitest run` from the root script.
    include: ["packages/**/*.{test,spec}.ts", "infra/**/*.{test,spec}.ts"],
    environment: "node",
  },
});
