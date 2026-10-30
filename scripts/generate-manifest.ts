#!/usr/bin/env tsx
/**
 * Regenerate the committed tool manifest from the live OpenAPI document.
 *
 * Usage:
 *   npm run generate           fetch the live spec and write the manifest
 *   npm run generate:check     fetch the live spec and verify the committed
 *                              manifest matches it (exit 1 on drift)
 *
 * The manifest is committed so the package works offline. `--check` is the
 * guard: it fails when the committed count or content drifts from the live
 * paid-route count.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverPaidRoutes,
  routesToTools,
  type OpenApiDocument,
} from '../src/openapi.js';
import type { ToolManifest } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const MANIFEST_PATH = resolve(ROOT, 'src/generated/tools.manifest.json');
const SPEC_PATH = resolve(ROOT, 'src/generated/openapi.snapshot.json');

const DEFAULT_SPEC_URL = 'https://x402.synthexforge.com/openapi.json';

async function fetchSpec(url: string): Promise<OpenApiDocument> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
  return (await response.json()) as OpenApiDocument;
}

/** Count the paid routes in a document — the number the manifest must match. */
export function countPaidRoutes(doc: OpenApiDocument): number {
  return discoverPaidRoutes(doc).length;
}

/** Build the manifest object from an OpenAPI document. */
export function buildManifest(
  doc: OpenApiDocument,
  specUrl: string,
  generatedAt: string,
): ToolManifest {
  const routes = discoverPaidRoutes(doc);
  const tools = routesToTools(routes);
  return {
    generatedAt,
    source: specUrl,
    sourceVersion: doc.info?.version ?? 'unknown',
    paidToolCount: tools.length,
    freeToolCount: 1,
    tools,
  };
}

/** Serialise the manifest deterministically (stable key order). */
export function serialiseManifest(manifest: ToolManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const specUrl =
    process.env['SYNTHX_SPEC_URL'] ?? DEFAULT_SPEC_URL;

  process.stderr.write(`fetching ${specUrl}\n`);
  const doc = await fetchSpec(specUrl);
  const livePaidCount = countPaidRoutes(doc);
  process.stderr.write(`live paid routes: ${livePaidCount}\n`);

  if (!check) {
    mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
    mkdirSync(dirname(SPEC_PATH), { recursive: true });
    writeFileSync(
      SPEC_PATH,
      `${JSON.stringify(doc, null, 2)}\n`,
      'utf-8',
    );
    const manifest = buildManifest(doc, specUrl, new Date().toISOString());
    writeFileSync(MANIFEST_PATH, serialiseManifest(manifest), 'utf-8');
    process.stderr.write(
      `wrote ${MANIFEST_PATH} (${manifest.paidToolCount} paid tools)\n`,
    );
    return;
  }

  // --- check mode ------------------------------------------------------
  let committed: ToolManifest;
  try {
    committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as ToolManifest;
  } catch {
    process.stderr.write(
      `FAIL: no committed manifest at ${MANIFEST_PATH}. Run \`npm run generate\`.\n`,
    );
    process.exit(1);
  }

  const problems: string[] = [];
  if (committed.paidToolCount !== livePaidCount) {
    problems.push(
      `committed paidToolCount=${committed.paidToolCount} != live paid-route count=${livePaidCount}`,
    );
  }
  if (committed.tools.length !== livePaidCount) {
    problems.push(
      `committed tools.length=${committed.tools.length} != live paid-route count=${livePaidCount}`,
    );
  }

  // The tool set must match the live route set exactly — no additions, no
  // omissions. A count match alone would not catch a swapped route.
  const livePaths = new Set(
    discoverPaidRoutes(doc).map((r) => `${r.method} ${r.path}`),
  );
  const committedPaths = new Set(
    committed.tools.map((t) => `${t.endpoint.method} ${t.remotePath}`),
  );
  for (const path of livePaths) {
    if (!committedPaths.has(path)) {
      problems.push(`missing from the committed manifest: ${path}`);
    }
  }
  for (const path of committedPaths) {
    if (!livePaths.has(path)) {
      problems.push(`stale in the committed manifest: ${path}`);
    }
  }

  if (problems.length > 0) {
    process.stderr.write('FAIL: manifest drift detected\n');
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.stderr.write('Run `npm run generate` to refresh.\n');
    process.exit(1);
  }

  process.stderr.write(
    `PASS: committed manifest matches the live spec (${livePaidCount} paid routes)\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`generate-manifest: ${message}\n`);
  process.exit(1);
});
