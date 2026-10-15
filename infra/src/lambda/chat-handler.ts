/**
 * API_Layer Chat Handler Lambda entry point (task 18.1).
 *
 * This is the thin AWS Lambda adapter that the API Gateway `/api/chat` route
 * invokes. It binds the pure, unit-tested chat handler factory from
 * `@claimclarify/api` to its production dependencies:
 *
 * - a {@link ConfigSource} backed by SSM Parameter Store (Config_Store), from
 *   which the handler reads the `BEDROCK_AGENT_ID` at runtime with no embedded
 *   fallback (Req 15.2, 15.3); and
 * - a Bedrock Agent Runtime invoker.
 *
 * The construct that wires this handler into API Gateway lives in
 * `claimclarify-stack.ts`. Following the task-17.1 seed-Lambda pattern, the
 * CDK code asset points at the compiled output directory (`dist/lambda`), so
 * `cdk synth` never needs esbuild/bundling or AWS credentials.
 *
 * The shared `ConfigSource` contract resolves keys synchronously, so this
 * adapter fetches required parameters from SSM once (lazily, memoized) and
 * serves them from an in-process cache. The concrete AWS SDK adapters (SSM +
 * Bedrock Agent Runtime) are intentionally minimal here; least-privilege IAM
 * for this function is attached in task 18.2 and the agent-invocation adapter
 * is exercised by the integration tests in task 22.
 */
import {
  AGENT_ID_CONFIG_KEY,
  createChatHandler,
  type AgentInvoker,
  type ApiGatewayProxyEvent,
  type ApiGatewayProxyResult,
} from "@claimclarify/api";
import type { ConfigSource } from "@claimclarify/shared";

/**
 * Map a logical Config_Store key to its physical SSM parameter name, mirroring
 * the naming the CDK stack applies (hierarchical names get a leading slash).
 */
function toParameterName(key: string): string {
  return key.includes("/") && !key.startsWith("/") ? `/${key}` : key;
}

/**
 * A synchronous {@link ConfigSource} backed by SSM Parameter Store. The shared
 * `loadConfig` reads keys synchronously, so values are pre-fetched into an
 * in-process cache during handler initialization. A key absent from both the
 * cache and SSM resolves to `undefined`, so `loadConfig` reports a CONFIG_ERROR
 * rather than falling back to an embedded value (Req 15.3).
 */
class SsmConfigSource implements ConfigSource {
  private readonly cache = new Map<string, string>();

  /**
   * Pre-load the given keys from SSM into the cache. Called once at cold start
   * before the first request so the synchronous `get` can serve them.
   */
  async preload(keys: readonly string[]): Promise<void> {
    const { SSMClient, GetParameterCommand } =
      // Deferred require keeps module load side-effect free for tooling.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("@aws-sdk/client-ssm") as typeof import("@aws-sdk/client-ssm");
    const client = new SSMClient({});
    for (const key of keys) {
      try {
        const out = await client.send(
          new GetParameterCommand({
            Name: toParameterName(key),
            WithDecryption: true,
          })
        );
        const value = out.Parameter?.Value;
        if (value !== undefined) {
          this.cache.set(key, value);
        }
      } catch {
        // Leave the key absent; loadConfig surfaces CONFIG_ERROR (Req 15.3).
      }
    }
  }

  get(key: string): string | undefined {
    return this.cache.get(key);
  }
}

/**
 * Bedrock Agent Runtime invoker. Forwards the validated chat request to the
 * configured agent id over the AWS SDK (which uses TLS by default). The SDK is
 * required lazily for the same module-load reasons as above.
 */
/**
 * Marker value the Config_Store `BEDROCK_AGENT_ID` holds before the
 * Bedrock_Agent is provisioned (core-only / phased deploy). When the resolved
 * agent id equals this marker, the agent has not been deployed yet, so the
 * invoker returns a deterministic response instead of calling Bedrock. This
 * keeps the end-to-end `/api/chat` path working on a core-only deployment; a
 * later full deploy replaces the marker with the real agent id.
 */
const AGENT_NOT_DEPLOYED_MARKER = "PLACEHOLDER_SET_IN_TASK_18";

function createBedrockAgentInvoker(): AgentInvoker {
  return {
    async invoke({ request, traceId, agentId }) {
      const sessionId = request.sessionId ?? traceId;

      // Core-only deploy: no Bedrock_Agent exists yet. Return a deterministic,
      // honest response rather than calling a non-existent agent.
      if (agentId === AGENT_NOT_DEPLOYED_MARKER) {
        return {
          response:
            "ClaimClarify is deployed and reachable. The AI triage agent " +
            "(Bedrock AgentCore) is not yet connected in this environment, " +
            "so I can't answer claim questions yet. Your message was: " +
            JSON.stringify(request.message),
          sessionId,
        };
      }

      const {
        BedrockAgentRuntimeClient,
        InvokeAgentCommand,
        // eslint-disable-next-line @typescript-eslint/no-var-requires
      } = require("@aws-sdk/client-bedrock-agent-runtime") as typeof import("@aws-sdk/client-bedrock-agent-runtime");
      const client = new BedrockAgentRuntimeClient({});
      const response = await client.send(
        new InvokeAgentCommand({
          agentId,
          agentAliasId: "TSTALIASID",
          sessionId,
          inputText: request.message,
        })
      );

      // Collect the streamed completion chunks into a single string.
      let text = "";
      const completion = response.completion;
      if (completion) {
        for await (const chunkEvent of completion) {
          const chunk = chunkEvent.chunk?.bytes;
          if (chunk) {
            text += Buffer.from(chunk).toString("utf8");
          }
        }
      }
      return { response: text, sessionId };
    },
  };
}

const configSource = new SsmConfigSource();
const configReady = configSource.preload([AGENT_ID_CONFIG_KEY]);

const handlerImpl = createChatHandler({
  configSource,
  agentInvoker: createBedrockAgentInvoker(),
});

/** API Gateway proxy entry point. */
export async function handler(
  event: ApiGatewayProxyEvent
): Promise<ApiGatewayProxyResult> {
  // Ensure config has been fetched from the Config_Store before serving.
  await configReady;
  return handlerImpl(event);
}
