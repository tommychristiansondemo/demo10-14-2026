/**
 * Config_Store wiring for the Policy_Lookup_Server (Req 15.2).
 *
 * The server never embeds the table name in source; it loads it from the
 * Config_Store at runtime via the shared {@link loadConfig}/{@link ConfigSource}
 * abstraction. A missing key yields a CONFIG_ERROR with no source-code fallback
 * (Req 15.3).
 */
import {
  loadConfig,
  type ConfigResult,
  type ConfigSource,
} from "@claimclarify/shared";

/** Config_Store key holding the Policy_Table name. */
export const POLICY_TABLE_NAME_KEY = "claimclarify/policy-lookup/table-name";

/**
 * Load the Policy_Table name from the Config_Store. Returns a CONFIG_ERROR when
 * the key is absent; never falls back to an embedded value (Req 15.2, 15.3).
 */
export function loadPolicyTableName(source: ConfigSource): ConfigResult {
  return loadConfig(source, POLICY_TABLE_NAME_KEY);
}
