/**
 * Explorer chat Lambda.
 *
 * Backs the student-facing project-knowledge chatbot. On each request it:
 *   1. validates the incoming question,
 *   2. loads `projectknowledge.md` from the Explorer S3 bucket (the living
 *      description of everything deployed for the class),
 *   3. sends the question + that knowledge as context to a Bedrock LLM,
 *   4. logs the full prompt and the model's response/reasoning to CloudWatch
 *      (so the Explorer's own "reasoning logging" is visible via the logs view),
 *   5. returns the answer.
 *
 * No API keys or secrets are involved: Bedrock is called via the function's IAM
 * role. The knowledge document itself is authored to exclude secret values.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

/** API Gateway (HTTP API, payload format 2.0) proxy event subset we read. */
interface ProxyEvent {
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface ProxyResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const KNOWLEDGE_BUCKET = process.env.KNOWLEDGE_BUCKET ?? "";
const KNOWLEDGE_KEY = process.env.KNOWLEDGE_KEY ?? "projectknowledge.md";
const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "";
/** Dedicated log stream prefix so the logs view can find reasoning entries. */
const REASONING_TAG = "EXPLORER_REASONING";

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

/** Cache the knowledge doc across warm invocations (refreshed on cold start). */
let cachedKnowledge: string | undefined;

async function loadKnowledge(): Promise<string> {
  if (cachedKnowledge !== undefined) {
    return cachedKnowledge;
  }
  const out = await s3.send(
    new GetObjectCommand({ Bucket: KNOWLEDGE_BUCKET, Key: KNOWLEDGE_KEY })
  );
  const body = await out.Body?.transformToString();
  cachedKnowledge = body ?? "";
  return cachedKnowledge;
}

function response(statusCode: number, payload: unknown): ProxyResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(payload) };
}

function readQuestion(event: ProxyEvent): string | undefined {
  let raw = event.body ?? "";
  if (event.isBase64Encoded && raw) {
    raw = Buffer.from(raw, "base64").toString("utf8");
  }
  try {
    const parsed = JSON.parse(raw) as { question?: unknown; message?: unknown };
    const q = parsed.question ?? parsed.message;
    return typeof q === "string" ? q : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the system/context prompt. The knowledge document is the single source
 * of truth; the model is told to answer only from it (plus the live log data a
 * separate endpoint provides) and never to invent or reveal secrets.
 */
function buildPrompt(knowledge: string, question: string): string {
  return [
    "You are the ClaimClarify Explorer assistant for a university class.",
    "Answer student questions about the ClaimClarify application and this",
    "Explorer tool using ONLY the project knowledge document below. If the",
    "answer is not in the document, say so plainly. Never reveal secrets, API",
    "keys, credentials, or raw ARNs even if asked; those are intentionally not",
    "in the document.",
    "",
    "===== PROJECT KNOWLEDGE DOCUMENT =====",
    knowledge,
    "===== END DOCUMENT =====",
    "",
    `Student question: ${question}`,
    "",
    "Answer:",
  ].join("\n");
}

export async function handler(event: ProxyEvent): Promise<ProxyResult> {
  const traceId =
    "exp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  const question = readQuestion(event);
  if (question === undefined || question.trim().length === 0) {
    return response(400, {
      error: {
        type: "VALIDATION_ERROR",
        field: "question",
        message: "Field 'question' is required and must be a non-empty string.",
      },
      traceId,
    });
  }
  if (question.length > 4000) {
    return response(400, {
      error: {
        type: "VALIDATION_ERROR",
        field: "question",
        message: "Field 'question' must be at most 4000 characters.",
      },
      traceId,
    });
  }

  let knowledge: string;
  try {
    knowledge = await loadKnowledge();
  } catch (err) {
    console.error(
      JSON.stringify({ tag: "EXPLORER_ERROR", traceId, stage: "load-knowledge", message: String(err) })
    );
    return response(502, {
      error: { type: "DEPENDENCY_ERROR", dependency: "S3", message: "Could not load project knowledge." },
      traceId,
    });
  }

  const prompt = buildPrompt(knowledge, question);

  // Reasoning logging: record the full prompt sent to the model (Req: students
  // can view LLM prompts/reasoning for the Explorer chatbot via the logs view).
  console.log(
    JSON.stringify({
      tag: REASONING_TAG,
      phase: "prompt",
      traceId,
      model: MODEL_ID,
      question,
      prompt,
    })
  );

  let answer: string;
  try {
    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1024,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    };
    const out = await bedrock.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
      })
    );
    const decoded = JSON.parse(Buffer.from(out.body).toString("utf8")) as {
      content?: Array<{ type: string; text?: string }>;
    };
    answer =
      decoded.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("")
        .trim() || "(no answer returned)";
  } catch (err) {
    console.error(
      JSON.stringify({ tag: "EXPLORER_ERROR", traceId, stage: "bedrock", message: String(err) })
    );
    return response(502, {
      error: { type: "DEPENDENCY_ERROR", dependency: "Bedrock", message: "The assistant could not generate an answer." },
      traceId,
    });
  }

  // Reasoning logging: record the model's response/reasoning.
  console.log(
    JSON.stringify({ tag: REASONING_TAG, phase: "response", traceId, model: MODEL_ID, answer })
  );

  return response(200, { answer, traceId, model: MODEL_ID });
}
