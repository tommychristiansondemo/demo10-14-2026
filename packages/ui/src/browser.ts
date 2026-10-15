/**
 * Browser bundle entry for the static Chat_UI.
 *
 * This module exists purely as the esbuild entry point for the browser bundle.
 * Importing `./index` triggers the auto-boot guard there, which locates the
 * DOM elements and mounts the controller against the real `document` and
 * `fetch`. Keeping this separate from `index.ts` lets `index.ts` remain the
 * importable, test-friendly module API while this file is the thing shipped to
 * `S3_Origin` and loaded by `index.html`.
 */
import "./index";
