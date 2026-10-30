#!/usr/bin/env node
/**
 * Post-build step: make the compiled CLI entry point executable.
 *
 * `tsc` does not preserve the executable bit, so `bin` would fail with
 * "permission denied" after `npm install -g`.
 */
import { chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = resolve(__dirname, '..', 'dist', 'cli.js');

if (!existsSync(target)) {
  console.error(`postbuild: ${target} not found — did tsc run?`);
  process.exit(1);
}
chmodSync(target, 0o755);
console.log(`postbuild: chmod 755 ${target}`);
