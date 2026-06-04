/**
 * Register the .js → .ts loader hook for integration tests.
 *
 * Usage: node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Handles two issues:
 * 1. Source files use .js import extensions (TypeScript ESM convention) but
 *    files on disk are .ts — the loader rewrites .js → .ts at resolve time.
 * 2. Tests run under Node's strip-types mode; source-level TypeScript syntax used
 *    by integration paths must stay compatible with strip-only execution.
 */

import { register } from "node:module";

register(new URL("./ts-loader.mjs", import.meta.url));
