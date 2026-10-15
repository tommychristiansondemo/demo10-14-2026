/**
 * Build the static Chat_UI browser bundle.
 *
 * Bundles `src/browser.ts` (which boots the controller + view against the real
 * DOM) into a single same-origin `app.js`, and copies the static assets
 * (`index.html`, `styles.css`) alongside it. The output in `dist/web` is what
 * gets uploaded to `S3_Origin` and served through CloudFront.
 */
import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const outDir = join(pkgRoot, "dist", "web");

async function main() {
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [join(pkgRoot, "src", "browser.ts")],
    bundle: true,
    format: "iife",
    target: ["es2019"],
    platform: "browser",
    minify: true,
    sourcemap: true,
    outfile: join(outDir, "app.js"),
    logLevel: "info",
  });

  for (const asset of ["index.html", "styles.css"]) {
    await copyFile(join(pkgRoot, "public", asset), join(outDir, asset));
  }

  console.log(`Chat_UI bundle written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
