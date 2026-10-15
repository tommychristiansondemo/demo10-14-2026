/**
 * Bundle the Explorer Lambda handlers into self-contained deploy artifacts at
 * `dist/lambda-bundle/<name>/index.js`. AWS SDK v3 is provided by the Node 20
 * Lambda runtime, so it is kept external to keep bundles small.
 */
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDir = join(root, "src", "lambda");
const outRoot = join(root, "dist", "lambda-bundle");

const HANDLERS = [
  { entry: join(srcDir, "chat.ts"), outDir: "chat" },
  { entry: join(srcDir, "logs.ts"), outDir: "logs" },
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
      external: ["@aws-sdk/*"],
      logLevel: "info",
    });
    console.log(`Bundled ${outDir}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
