/**
 * Observability synthesis tests (task 21.5).
 *
 * Credential-free assertions against the synthesized CloudFormation template of
 * the Primary_Region (`us-east-2`) ClaimClarifyDataStack, verifying the
 * Observability_Service wiring (Req 12.1–12.4) defined by
 * {@link ClaimClarifyCompute}:
 *
 * - **Log groups (Req 12.1):** an explicit CloudWatch Log_Group exists for ALL
 *   FOUR monitored components — the Bedrock_Agent, the API_Layer chat Lambda,
 *   the Policy_Lookup_Server, and the Repair_Estimator_Server. The agent and
 *   the two MCP-server groups carry the service naming conventions
 *   (`/aws/bedrock/agents/...`, `/aws/bedrock-agentcore/runtimes/...`), and the
 *   chat Lambda has its own explicit (not implicit) group attached to the
 *   function.
 * - **Metrics (Req 12.2):** invocation / error / latency are represented for
 *   the API_Layer Lambda and both MCP servers. The Lambda uses its built-in
 *   `AWS/Lambda` metrics; the MCP servers emit custom
 *   `ClaimClarify/MCP` Invocations/Errors/Latency. The error-rate alarms carry
 *   a `MathExpression` over errors + invocations, and the MCP metric
 *   namespace/names appear in the synthesized alarm metric definitions.
 * - **Alarms (Req 12.3, 12.4):** exactly three `AWS::CloudWatch::Alarm`
 *   resources (one per monitored component), each with Threshold 5,
 *   ComparisonOperator GreaterThanThreshold, EvaluationPeriods 1, a 300-second
 *   (5-minute) period, a `MathExpression` computing the error rate, and the
 *   default ALARM↔OK transition behavior (actions not disabled, no suppressed
 *   state).
 *
 * The exported constants from the compute module are used so the assertions
 * stay in lock-step with the construct definition.
 */
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { ClaimClarifyDataStack, PRIMARY_REGION } from "./claimclarify-stack";
import {
  ERROR_RATE_ALARM_THRESHOLD_PERCENT,
  ERROR_RATE_ALARM_PERIOD_MINUTES,
  MCP_METRIC_NAMESPACE,
  MCP_INVOCATION_METRIC,
  MCP_ERROR_METRIC,
  MCP_LATENCY_METRIC,
  POLICY_LOOKUP_SERVER_DIMENSION,
  REPAIR_ESTIMATOR_SERVER_DIMENSION,
} from "./claimclarify-compute-stack";

/** The alarm evaluation period expressed in seconds (5 minutes → 300s). */
const ALARM_PERIOD_SECONDS = ERROR_RATE_ALARM_PERIOD_MINUTES * 60;

/**
 * Synthesize the data stack on its own (no cross-region certificate needed for
 * observability assertions). All CloudWatch resources live in this
 * Primary_Region (`us-east-2`) stack.
 */
function synth(): { stack: ClaimClarifyDataStack; template: Template } {
  const app = new App();
  const stack = new ClaimClarifyDataStack(app, "TestObservability", {
    env: { account: "111111111111", region: PRIMARY_REGION },
  });
  return { stack, template: Template.fromStack(stack) };
}

describe("ClaimClarify observability synthesis (task 21.5)", () => {
  describe("log groups for all four components (Req 12.1)", () => {
    it("emits at least four explicit CloudWatch log groups", () => {
      const { template } = synth();
      // Bedrock_Agent, chat Lambda, policy-lookup, repair-estimator — one each.
      expect(
        Object.keys(template.findResources("AWS::Logs::LogGroup")).length
      ).toBeGreaterThanOrEqual(4);
    });

    it("names the Bedrock_Agent log group with the /aws/bedrock/agents convention", () => {
      const { template } = synth();
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName: Match.stringLikeRegexp("^/aws/bedrock/agents/.+"),
      });
    });

    it("names BOTH MCP-server log groups with the AgentCore runtimes convention", () => {
      const { template } = synth();
      // Policy_Lookup_Server group.
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName:
          "/aws/bedrock-agentcore/runtimes/claimclarify_policy_lookup",
      });
      // Repair_Estimator_Server group.
      template.hasResourceProperties("AWS::Logs::LogGroup", {
        LogGroupName:
          "/aws/bedrock-agentcore/runtimes/claimclarify_repair_estimator",
      });
    });

    it("attaches an explicit log group to the API_Layer chat Lambda", () => {
      const { stack, template } = synth();

      // The function references an explicit LogGroup (not an implicit one): its
      // LoggingConfig points at a log group resource defined in-stack.
      const functions = template.findResources("AWS::Lambda::Function", {
        Properties: {
          LoggingConfig: Match.objectLike({ LogGroup: Match.anyValue() }),
        },
      });
      // The chat handler is the function wired to the explicit chat-handler log
      // group; assert at least one function carries an explicit log group.
      expect(Object.keys(functions).length).toBeGreaterThan(0);

      // Cross-check against the construct reference: the chat Lambda's explicit
      // group is exposed as logGroups.chatHandler (Req 12.1).
      expect(stack.compute.logGroups.chatHandler).toBeDefined();
    });

    it("exposes log group references for all four components on the construct", () => {
      const { stack } = synth();
      const { logGroups } = stack.compute;
      expect(logGroups.bedrockAgent).toBeDefined();
      expect(logGroups.chatHandler).toBeDefined();
      expect(logGroups.policyLookup).toBeDefined();
      expect(logGroups.repairEstimator).toBeDefined();
    });
  });

  describe("metrics for the API Lambda and MCP servers (Req 12.2)", () => {
    it("represents invocation/error/latency for the API_Layer Lambda and both MCP servers on the construct", () => {
      const { stack } = synth();
      const { metrics } = stack.compute;

      for (const component of [
        metrics.chatHandler,
        metrics.policyLookup,
        metrics.repairEstimator,
      ]) {
        expect(component.invocations).toBeDefined();
        expect(component.errors).toBeDefined();
        expect(component.latency).toBeDefined();
      }
    });

    it("uses the custom ClaimClarify/MCP namespace with Invocations/Errors/Latency metric names", () => {
      const { stack } = synth();
      const { policyLookup, repairEstimator } = stack.compute.metrics;

      // Policy_Lookup_Server MCP metrics.
      expect(policyLookup.invocations.toMetricConfig().metricStat).toMatchObject(
        {
          namespace: MCP_METRIC_NAMESPACE,
          metricName: MCP_INVOCATION_METRIC,
        }
      );
      expect(policyLookup.errors.toMetricConfig().metricStat).toMatchObject({
        namespace: MCP_METRIC_NAMESPACE,
        metricName: MCP_ERROR_METRIC,
      });
      expect(policyLookup.latency.toMetricConfig().metricStat).toMatchObject({
        namespace: MCP_METRIC_NAMESPACE,
        metricName: MCP_LATENCY_METRIC,
      });

      // Repair_Estimator_Server MCP metrics.
      expect(
        repairEstimator.invocations.toMetricConfig().metricStat
      ).toMatchObject({
        namespace: MCP_METRIC_NAMESPACE,
        metricName: MCP_INVOCATION_METRIC,
      });
      expect(repairEstimator.latency.toMetricConfig().metricStat).toMatchObject({
        namespace: MCP_METRIC_NAMESPACE,
        metricName: MCP_LATENCY_METRIC,
      });
    });

    it("materializes the API_Layer Lambda invocation + error metrics into the synthesized error-rate alarm", () => {
      const { template } = synth();
      // The chat Lambda's error-rate alarm carries its built-in AWS/Lambda
      // Errors and Invocations metrics inside the MathExpression's usingMetrics.
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Metrics: Match.arrayWith([
          Match.objectLike({
            Id: "errors",
            MetricStat: Match.objectLike({
              Metric: Match.objectLike({
                Namespace: "AWS/Lambda",
                MetricName: "Errors",
              }),
            }),
          }),
          Match.objectLike({
            Id: "invocations",
            MetricStat: Match.objectLike({
              Metric: Match.objectLike({
                Namespace: "AWS/Lambda",
                MetricName: "Invocations",
              }),
            }),
          }),
        ]),
      });
    });

    it("materializes the MCP namespace Invocations/Errors metrics into the MCP server alarms", () => {
      const { template } = synth();

      for (const serverDimension of [
        POLICY_LOOKUP_SERVER_DIMENSION,
        REPAIR_ESTIMATOR_SERVER_DIMENSION,
      ]) {
        // Errors metric for this MCP server.
        template.hasResourceProperties("AWS::CloudWatch::Alarm", {
          Metrics: Match.arrayWith([
            Match.objectLike({
              MetricStat: Match.objectLike({
                Metric: Match.objectLike({
                  Namespace: MCP_METRIC_NAMESPACE,
                  MetricName: MCP_ERROR_METRIC,
                  Dimensions: Match.arrayWith([
                    { Name: "Server", Value: serverDimension },
                  ]),
                }),
              }),
            }),
            Match.objectLike({
              MetricStat: Match.objectLike({
                Metric: Match.objectLike({
                  Namespace: MCP_METRIC_NAMESPACE,
                  MetricName: MCP_INVOCATION_METRIC,
                  Dimensions: Match.arrayWith([
                    { Name: "Server", Value: serverDimension },
                  ]),
                }),
              }),
            }),
          ]),
        });
      }
    });
  });

  describe("error-rate alarms (Req 12.3, 12.4)", () => {
    it("defines exactly three CloudWatch alarms — one per monitored component", () => {
      const { template } = synth();
      template.resourceCountIs("AWS::CloudWatch::Alarm", 3);
    });

    it("configures every alarm with threshold 5, GreaterThanThreshold, 1 evaluation period, and a 5-minute period", () => {
      const { template } = synth();
      const alarms = template.findResources("AWS::CloudWatch::Alarm");
      const alarmList = Object.values(alarms);
      expect(alarmList.length).toBe(3);

      for (const alarm of alarmList) {
        const props = alarm.Properties;
        // 5% threshold, strictly-greater comparison, single evaluation window.
        expect(props.Threshold).toBe(ERROR_RATE_ALARM_THRESHOLD_PERCENT);
        expect(props.Threshold).toBe(5);
        expect(props.ComparisonOperator).toBe("GreaterThanThreshold");
        expect(props.EvaluationPeriods).toBe(1);

        // The alarm is a math expression over errors + invocations; every
        // sub-metric is evaluated over the 5-minute (300s) window.
        const metrics = props.Metrics as Array<Record<string, unknown>>;
        expect(Array.isArray(metrics)).toBe(true);

        const expression = metrics.find(
          (m) => typeof m.Expression === "string"
        );
        expect(expression).toBeDefined();
        expect(expression?.Expression).toContain("errors");
        expect(expression?.Expression).toContain("invocations");

        for (const m of metrics) {
          const metricStat = m.MetricStat as
            | { Period?: number }
            | undefined;
          if (metricStat) {
            expect(metricStat.Period).toBe(ALARM_PERIOD_SECONDS);
            expect(metricStat.Period).toBe(300);
          }
        }
      }
    });

    it("computes the error rate via a MathExpression on every alarm (Req 12.3)", () => {
      const { template } = synth();
      // Each alarm carries a Metrics array whose first entry is an expression
      // metric computing error rate (errors / invocations * 100).
      template.hasResourceProperties("AWS::CloudWatch::Alarm", {
        Metrics: Match.arrayWith([
          Match.objectLike({
            Expression: Match.stringLikeRegexp(".*errors.*invocations.*"),
            ReturnData: true,
          }),
        ]),
      });
    });

    it("leaves alarm actions enabled and does not suppress state so ALARM↔OK transitions work (Req 12.3, 12.4)", () => {
      const { template } = synth();
      const alarms = template.findResources("AWS::CloudWatch::Alarm");

      for (const alarm of Object.values(alarms)) {
        const props = alarm.Properties;
        // ActionsEnabled must not be explicitly disabled: default (undefined →
        // true) or true both allow the alarm to transition between ALARM and
        // OK. Missing data is "notBreaching" so a quiet component resolves to
        // OK rather than sticking in INSUFFICIENT_DATA.
        expect(props.ActionsEnabled).not.toBe(false);
        expect(props.TreatMissingData).toBe("notBreaching");
      }
    });

    it("exposes the three error-rate alarms on the construct", () => {
      const { stack } = synth();
      const { alarms } = stack.compute;
      expect(alarms.chatHandler).toBeDefined();
      expect(alarms.policyLookup).toBeDefined();
      expect(alarms.repairEstimator).toBeDefined();
    });
  });
});
