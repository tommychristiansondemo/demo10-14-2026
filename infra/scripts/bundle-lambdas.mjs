/**
 * Bundle the infra Lambda handlers into self-contained deploy artifacts.
 *
 * The CDK Lambda code assets point at per-handler directories under
 * `dist/lambda-bundle/<name>/`, each containing a single `index.js` with the
 * handler and ALL of its dependencies inlined by esbuild. This is required
 * because the handlers `require` workspace packages (`@claimclarify/api`,
 * `@claimclarify/shared`) and third-party SDK clients that are NOT present in a
 * bare `tsc` output directory — without bundling, the Lambda would crash on
 * cold start with "Cannot find module".
 *
 * The AWS SDK v3 is available in the Lambda Node 20 runtime, so `@aws-sdk/*`
 * packages are marked external to keep the bundle small; everything else
 * (including the workspace packages) is inlined.
 *
 * Each output directory exposes `index.handler`, so the CDK functions set
 * `handler: "index.handler"` and `code: fromAsset(dist/lambda-bundle/<name>)`.
 */
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const infraRoot = join(here, "..");
const srcLambdaDir = join(infraRoot, "src", "lambda");
const outRoot = join(infraRoot, "dist", "lambda-bundle");

/** The handlers to bundle: source entry → output subdirectory. */
const HANDLERS = [
  { entry: join(srcLambdaDir, "chat-handler.ts"), outDir: "chat-handler" },
  {
    entry: join(srcLambdaDir, "seed-policy-table.ts"),
    outDir: "seed-policy-table",
  },
];

async function main() {
  await rm(outRoot, { recursive: true, force: true });

  for (const { entry, outDir } of HANDLERS) {
    const dir = join(outRoot, outDir);
    await mkdir(dir, { recursive: true });

    await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      target: "node20",
      format: "cjs",
      outfile: join(dir, "index.js"),
      sourcemap: true,
      // The Lambda Node 20 runtime ships the AWS SDK v3; keep it external so we
      // do not bloat the bundle. Everything else (workspace packages, MCP SDK,
      // etc.) is inlined so the handler is self-contained.
      external: ["@aws-sdk/*"],
      logLevel: "info",
    });

    console.log(`Bundled ${outDir} -> ${join(dir, "index.js")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
