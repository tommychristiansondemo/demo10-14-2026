/**
 * Resolve the directory of a bundled Lambda deploy artifact.
 *
 * The infra Lambda handlers are bundled (self-contained, workspace deps
 * inlined) by `scripts/bundle-lambdas.mjs` into
 * `infra/dist/lambda-bundle/<name>/index.js`. The CDK constructs that reference
 * these assets run both from compiled code (`infra/dist/...` during
 * `cdk deploy`) and from TypeScript source (`infra/src/...` during the Vitest
 * synthesis tests). In BOTH cases `__dirname` of this module is exactly one
 * directory below the infra package root (`infra/dist` or `infra/src`), so
 * resolving `<__dirname>/../dist/lambda-bundle/<name>` yields the single
 * bundle location regardless of where the caller is running from.
 *
 * This keeps `Template.fromStack(...)` happy in tests (which otherwise fail
 * with "Cannot find asset") while pointing `cdk deploy` at the real bundle.
 */
import * as path from "node:path";

/** Absolute path to the bundled Lambda artifact directory for `name`. */
export function lambdaBundleDir(name: string): string {
  // `__dirname` is `infra/dist` (deploy) or `infra/src` (tests); the bundle
  // always lives under `infra/dist/lambda-bundle`.
  return path.join(__dirname, "..", "dist", "lambda-bundle", name);
}
