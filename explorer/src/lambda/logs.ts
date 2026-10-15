/**
 * Explorer logs Lambda.
 *
 * Returns recent CloudWatch Logs events so students can see the running system,
 * including the Explorer chatbot's own LLM prompt/response ("reasoning")
 * entries. Access is READ-ONLY and limited to an allow-list of ClaimClarify +
 * Explorer log groups passed in via environment (never the whole account).
 *
 * Defense in depth: even though the knowledge document and app config avoid
 * secrets, this handler redacts anything that pattern-matches a credential
 * before returning it, so a stray secret in a log line is never surfaced to
 * students.
 */
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

interface ProxyEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
}

interface ProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const logs = new CloudWatchLogsClient({});

const JSON_HEADERS: Record<string, string> = { "Content-Type": "application/json" };

/** Comma-separated allow-list of log group names this endpoint may read. */
const ALLOWED_LOG_GROUPS = (process.env.ALLOWED_LOG_GROUPS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

/** Patterns that redact likely secrets from any returned log line. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/(aws_secret_access_key|secret|password|apikey|api_key|token)\s*[=:]\s*\S+/gi, "$1=[REDACTED]"],
  [/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, "[REDACTED_JWT]"],
];

function redact(line: string): string {
  let out = line;
  for (const [re, repl] of SECRET_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

function response(statusCode: number, payload: unknown): ProxyResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

function readParams(event: ProxyEvent): { group?: string; reasoningOnly: boolean; limit: number } {
  // Accept params from query string or JSON body.
  let group = event.queryStringParameters?.group;
  let reasoningOnly = event.queryStringParameters?.reasoningOnly === "true";
  let limit = Number(event.queryStringParameters?.limit ?? "40");
  let raw = event.body ?? "";
  if (event.isBase64Encoded && raw) {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        group?: string;
        reasoningOnly?: boolean;
        limit?: number;
      };
      if (typeof parsed.group === "string") group = parsed.group;
      if (typeof parsed.reasoningOnly === "boolean") reasoningOnly = parsed.reasoningOnly;
      if (typeof parsed.limit === "number") limit = parsed.limit;
    } catch {
      // ignore body parse errors; fall back to query params
    }
  }
  limit = Math.max(1, Math.min(Number.isFinite(limit) ? limit : 40, 100));
  return { group, reasoningOnly, limit };
}

export async function handler(event: ProxyEvent): Promise<ProxyResult> {
  const { group, reasoningOnly, limit } = readParams(event);

  // If a specific group is requested it MUST be in the allow-list.
  const groupsToRead =
    group !== undefined
      ? ALLOWED_LOG_GROUPS.filter((g) => g === group)
      : ALLOWED_LOG_GROUPS;

  if (group !== undefined && groupsToRead.length === 0) {
    return response(403, {
      error: {
        type: "FORBIDDEN",
        message: "Requested log group is not in the allowed set.",
      },
    });
  }

  // Discover which allowed groups actually exist (some may not be created yet).
  const existing = new Set<string>();
  try {
    for (const g of groupsToRead) {
      const d = await logs.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: g, limit: 5 })
      );
      for (const lg of d.logGroups ?? []) {
        if (lg.logGroupName && groupsToRead.includes(lg.logGroupName)) {
          existing.add(lg.logGroupName);
        }
      }
    }
  } catch (err) {
    console.error(JSON.stringify({ tag: "EXPLORER_ERROR", stage: "describe-groups", message: String(err) }));
  }

  const since = Date.now() - 24 * 60 * 60 * 1000; // last 24h
  const results: Array<{ group: string; timestamp: number; message: string }> = [];

  for (const g of existing) {
    try {
      const filterPattern = reasoningOnly ? "EXPLORER_REASONING" : undefined;
      const out = await logs.send(
        new FilterLogEventsCommand({
          logGroupName: g,
          startTime: since,
          limit,
          ...(filterPattern ? { filterPattern: `"${filterPattern}"` } : {}),
        })
      );
      for (const e of out.events ?? []) {
        results.push({
          group: g,
          timestamp: e.timestamp ?? 0,
          message: redact(e.message ?? ""),
        });
      }
    } catch (err) {
      console.error(
        JSON.stringify({ tag: "EXPLORER_ERROR", stage: "filter", group: g, message: String(err) })
      );
    }
  }

  results.sort((a, b) => b.timestamp - a.timestamp);

  return response(200, {
    groupsQueried: [...existing],
    reasoningOnly,
    count: results.length,
    events: results.slice(0, limit),
  });
}
