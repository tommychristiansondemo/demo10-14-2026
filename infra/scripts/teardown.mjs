#!/usr/bin/env node
/**
 * ClaimClarify teardown script (task 19.5, Req 14.4, 14.5).
 *
 * This is a DEPLOY-TIME operational script, not part of `npm run build`,
 * `npm test`, or `npm run synth`. It:
 *
 *   1. Runs `cdk destroy --all --force` to remove every ClaimClarify stack
 *      (Req 14.4). All stack resources use `RemovalPolicy.DESTROY` and the
 *      S3_Origin uses `autoDeleteObjects`, so a destroy can remove them all.
 *   2. After the destroy, queries CloudFormation for each ClaimClarify stack
 *      (`describe-stacks` / `describe-stack-resources`) to find anything still
 *      present, and prints a clear report of any resources that could NOT be
 *      removed (Req 14.5).
 *
 * It is robust when AWS is unreachable: the AWS CLI / cdk may not be installed
 * and credentials may be absent (this file is imported by the build/test tool
 * chain only indirectly via its pure helpers). Running it without AWS access
 * fails loudly with a non-zero exit code and a readable message rather than
 * throwing an unhandled error, so it never silently "succeeds".
 *
 * Usage:
 *   npm run teardown            # from infra/ (invokes this script)
 *   node scripts/teardown.mjs   # equivalent
 *
 * The pure parsing/reporting logic lives in `./teardown-report.mjs` and is unit
 * tested in `infra/src/teardown-report.test.ts`.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  CLAIMCLARIFY_STACKS,
  parseStackPresence,
  parseFailedResources,
  buildTeardownReport,
  formatTeardownReport,
} from "./teardown-report.mjs";

/**
 * Run a command synchronously, capturing stdout/stderr. Never throws on a
 * non-zero exit (so teardown can keep going and still report leftovers); the
 * caller inspects `status`.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ inheritStdio?: boolean }} [options]
 * @returns {{ status: number | null, stdout: string, stderr: string, spawnError: Error | undefined }}
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.inheritStdio ? "inherit" : "pipe",
    // Allow .cmd shims (cdk/aws on Windows) to resolve.
    shell: process.platform === "win32",
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    spawnError: result.error,
  };
}

/**
 * Resolve the cdk executable: prefer a local `cdk` on PATH, else fall back to
 * `npx cdk`. Returns the command + leading args.
 *
 * @returns {{ cmd: string, baseArgs: string[] }}
 */
function resolveCdk() {
  const probe = run("cdk", ["--version"]);
  if (probe.spawnError === undefined && probe.status === 0) {
    return { cmd: "cdk", baseArgs: [] };
  }
  return { cmd: "npx", baseArgs: ["cdk"] };
}

/**
 * Invoke `cdk destroy --all --force` (Req 14.4). Returns whether the command
 * ran and its exit status; teardown continues to the reporting phase either
 * way so leftovers are always reported (Req 14.5).
 *
 * @returns {{ ran: boolean, status: number | null, message: string }}
 */
function cdkDestroyAll() {
  const { cmd, baseArgs } = resolveCdk();
  console.log(`\nRunning: ${cmd} ${[...baseArgs, "destroy", "--all", "--force"].join(" ")}`);

  const result = run(cmd, [...baseArgs, "destroy", "--all", "--force"], {
    inheritStdio: true,
  });

  if (result.spawnError !== undefined) {
    return {
      ran: false,
      status: null,
      message: `Could not launch cdk (${result.spawnError.message}). Is the AWS CDK installed?`,
    };
  }

  return {
    ran: true,
    status: result.status,
    message:
      result.status === 0
        ? "cdk destroy reported success."
        : `cdk destroy exited with status ${result.status}; checking for leftover resources.`,
  };
}

/**
 * Query CloudFormation for a single stack and determine whether it (or any of
 * its resources) survived the destroy. Uses the AWS CLI; if the CLI is missing
 * or AWS is unreachable, the stack is reported as "present with unknown status"
 * so teardown never silently claims success (Req 14.5).
 *
 * @param {{ name: string, region: string }} stack
 * @returns {{ stackName: string, region: string, present: boolean, status: string | null, failedResources: Array<{ logicalId: string, resourceType: string, status: string }> }}
 */
function inspectStack(stack) {
  const describe = run("aws", [
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stack.name,
    "--region",
    stack.region,
    "--output",
    "json",
  ]);

  if (describe.spawnError !== undefined) {
    // AWS CLI not available — cannot confirm removal.
    return {
      stackName: stack.name,
      region: stack.region,
      present: true,
      status: null,
      failedResources: [],
    };
  }

  // describe-stacks returns non-zero + "does not exist" when the stack is gone;
  // feed either stdout (success) or stderr (not-found/error) to the parser.
  const describeText = describe.status === 0 ? describe.stdout : describe.stderr;
  const presence = parseStackPresence(stack.name, describeText);

  if (!presence.present) {
    return {
      stackName: stack.name,
      region: stack.region,
      present: false,
      status: presence.status,
      failedResources: [],
    };
  }

  // Stack still present: enumerate resources to surface which ones failed to
  // delete (best effort — if this call fails we still report the stack).
  const resources = run("aws", [
    "cloudformation",
    "describe-stack-resources",
    "--stack-name",
    stack.name,
    "--region",
    stack.region,
    "--output",
    "json",
  ]);

  const failedResources =
    resources.spawnError === undefined && resources.status === 0
      ? parseFailedResources(stack.name, resources.stdout)
      : [];

  return {
    stackName: stack.name,
    region: stack.region,
    present: true,
    status: presence.status,
    failedResources,
  };
}

/**
 * Entry point: destroy everything, then report any leftovers (Req 14.4, 14.5).
 */
function main() {
  console.log("ClaimClarify teardown — removing all stacks and reporting leftovers.");

  const destroy = cdkDestroyAll();
  console.log(destroy.message);

  // Whether or not destroy succeeded, inspect every targeted stack so the
  // report always reflects reality (Req 14.5).
  const stackResults = CLAIMCLARIFY_STACKS.map(inspectStack);
  const report = buildTeardownReport(stackResults);

  console.log(formatTeardownReport(report));

  // Exit non-zero when anything was not removed OR destroy itself failed, so
  // callers/CI can detect an incomplete teardown.
  if (!report.allRemoved) {
    process.exitCode = 1;
    return;
  }
  if (destroy.ran && destroy.status !== 0) {
    process.exitCode = destroy.status ?? 1;
  }
}

main();
