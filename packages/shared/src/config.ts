/**
 * Runtime configuration/secret loading, abstracted behind a {@link ConfigSource}
 * so every ClaimClarify component reads from the Config_Store (SSM Parameter
 * Store / Secrets Manager) at runtime rather than from embedded source values.
 *
 * This module is pure: it performs no AWS I/O itself. Concrete adapters (an SSM
 * or Secrets Manager client) implement {@link ConfigSource}; an in-memory fake
 * is provided for tests. See design.md "Config_Store (SSM / Secrets Manager)"
 * and the Error Handling table (Req 15.2, 15.3).
 */

import type { StructuredError } from "./errors";

/**
 * A read-only abstraction over the Config_Store (SSM Parameter Store or Secrets
 * Manager). Implementations resolve a configuration/secret key to its value, or
 * return `undefined` when the key is absent.
 *
 * The interface is deliberately minimal — a single lookup — so that it can be
 * backed by SSM, Secrets Manager, or an in-memory fake in tests, and so the
 * pure {@link loadConfig} logic stays independent of any AWS SDK (Req 15.2).
 */
export interface ConfigSource {
  /**
   * Resolve the value for `key`.
   *
   * @returns the stored value, or `undefined` if the key is not present in the
   *   Config_Store.
   */
  get(key: string): string | undefined;
}

/**
 * Result of {@link loadConfig}.
 *
 * On success, the resolved `value` read from the {@link ConfigSource}. On
 * failure (a required key is missing), a CONFIG_ERROR naming the missing key —
 * never a value embedded in source code (Req 15.3).
 */
export type ConfigResult =
  | { ok: true; value: string }
  | { ok: false; error: StructuredError };

/**
 * Load a required configuration value or secret from the Config_Store at
 * runtime (Req 15.2).
 *
 * Reads `key` from the supplied {@link ConfigSource}. The value is returned
 * exactly as provided by the source, including the empty string — only a
 * genuinely absent key (`undefined`) is treated as a retrieval failure.
 *
 * If the key is absent, returns a CONFIG_ERROR identifying the missing key and
 * does not fall back to any value embedded in source code (Req 15.3). This
 * function intentionally contains no hardcoded configuration/secret defaults.
 *
 * @param source The Config_Store abstraction to read from.
 * @param key The required configuration/secret key.
 */
export function loadConfig(source: ConfigSource, key: string): ConfigResult {
  const value = source.get(key);
  if (value === undefined) {
    return {
      ok: false,
      error: {
        type: "CONFIG_ERROR",
        message: `Required configuration key '${key}' could not be retrieved from the Config_Store.`,
      },
    };
  }
  return { ok: true, value };
}

/**
 * An in-memory {@link ConfigSource} for tests and local use.
 *
 * Backed by a plain key/value map; a missing key resolves to `undefined`,
 * exercising the CONFIG_ERROR path of {@link loadConfig}. This is a test/local
 * helper only — it is not a source-code fallback for production configuration.
 */
export class InMemoryConfigSource implements ConfigSource {
  private readonly entries: Map<string, string>;

  constructor(entries: Readonly<Record<string, string>> = {}) {
    this.entries = new Map(Object.entries(entries));
  }

  get(key: string): string | undefined {
    return this.entries.get(key);
  }
}
