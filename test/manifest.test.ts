/**
 * Manifest + tool-list tests.
 *
 * These assert the honesty properties of the generated manifest:
 *  - one tool per paid route, no more, no fewer
 *  - tool names are unique and stable
 *  - the committed manifest matches the committed OpenAPI snapshot
 *  - exactly ONE free tool ships
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  discoverPaidRoutes,
  routesToTools,
  slugify,
  toJsonSchema,
  type OpenApiDocument,
} from '../src/openapi.js';
import { buildToolList, MANIFEST } from '../src/server.js';
import { FREE_TOOL_NAME } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function loadSnapshot(): OpenApiDocument {
  const raw = readFileSync(
    resolve(ROOT, 'src/generated/openapi.snapshot.json'),
    'utf-8',
  );
  return JSON.parse(raw) as OpenApiDocument;
}

describe('committed manifest', () => {
  it('has a non-empty paid tool set', () => {
    expect(MANIFEST.paidToolCount).toBeGreaterThan(0);
    expect(MANIFEST.tools).toHaveLength(MANIFEST.paidToolCount);
  });

  it('declares exactly one free tool', () => {
    expect(MANIFEST.freeToolCount).toBe(1);
  });

  it('matches the committed OpenAPI snapshot route-for-route', () => {
    const snapshot = loadSnapshot();
    const liveRoutes = discoverPaidRoutes(snapshot);
    const liveKeys = new Set(
      liveRoutes.map((r) => `${r.method} ${r.path}`),
    );
    const manifestKeys = new Set(
      MANIFEST.tools.map((t) => `${t.endpoint.method} ${t.remotePath}`),
    );

    expect(manifestKeys.size).toBe(liveKeys.size);
    for (const key of liveKeys) {
      expect(manifestKeys.has(key)).toBe(true);
    }
    for (const key of manifestKeys) {
      expect(liveKeys.has(key)).toBe(true);
    }
  });

  it('regenerating from the snapshot produces the same tool set', () => {
    const snapshot = loadSnapshot();
    const regenerated = routesToTools(discoverPaidRoutes(snapshot));
    expect(regenerated.map((t) => t.name)).toEqual(
      MANIFEST.tools.map((t) => t.name),
    );
  });

  it('has unique tool names', () => {
    const names = MANIFEST.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('uses names that are valid MCP tool identifiers', () => {
    for (const tool of MANIFEST.tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it('gives every tool a JSON Schema object input', () => {
    for (const tool of MANIFEST.tools) {
      expect(tool.inputSchema['type']).toBe('object');
      expect(typeof tool.inputSchema['properties']).toBe('object');
    }
  });

  it('carries price, method and path on every tool', () => {
    for (const tool of MANIFEST.tools) {
      expect(tool.pricing.amountUsd).toMatch(/^\d+(\.\d+)?$/);
      expect(tool.pricing.amountAtomic).toMatch(/^\d+$/);
      expect(tool.pricing.currency).toBe('USD');
      expect(tool.pricing.network).toBe('eip155:8453');
      expect(tool.pricing.assetSymbol).toBe('USDC');
      expect(tool.endpoint.method).toMatch(/^(GET|POST|PUT|DELETE|PATCH)$/);
      expect(tool.remotePath.startsWith('/')).toBe(true);
    }
  });

  it('does not contain an unresolvable $ref in any input schema', () => {
    for (const tool of MANIFEST.tools) {
      const serialised = JSON.stringify(tool.inputSchema);
      expect(serialised).not.toContain('"$ref"');
    }
  });
});

describe('tool list', () => {
  it('exposes every paid tool plus exactly one free tool', () => {
    const tools = buildToolList();
    expect(tools).toHaveLength(MANIFEST.paidToolCount + 1);
    const free = tools.filter((t) => t.name === FREE_TOOL_NAME);
    expect(free).toHaveLength(1);
  });

  it('exposes the free catalogue tool with no arguments', () => {
    const catalogue = buildToolList().find((t) => t.name === FREE_TOOL_NAME);
    expect(catalogue).toBeDefined();
    expect(catalogue?.inputSchema['type']).toBe('object');
  });

  it('marks every paid tool with its price in _meta', () => {
    for (const tool of buildToolList()) {
      if (tool.name === FREE_TOOL_NAME) continue;
      const meta = tool._meta as Record<string, unknown> | undefined;
      const price = meta?.['synthex.io/price'] as Record<string, unknown> | undefined;
      expect(price).toBeDefined();
      expect(price?.['amount']).toBeTruthy();
      const endpoint = meta?.['synthex.io/endpoint'] as Record<string, unknown> | undefined;
      expect(endpoint?.['path']).toBeTruthy();
      expect(endpoint?.['method']).toBeTruthy();
    }
  });
});

describe('slugify', () => {
  it('produces a stable slug from a path', () => {
    expect(slugify('POST', '/v1/x402/quote')).toBe('v1_x402_quote');
    expect(slugify('GET', '/v1/social/search')).toBe('v1_social_search');
  });

  it('prefixes a name that would start with a digit', () => {
    expect(slugify('GET', '/1st/route').startsWith('x_')).toBe(true);
  });
});

describe('toJsonSchema', () => {
  it('inlines local $refs', () => {
    const doc: OpenApiDocument = {
      components: {
        schemas: {
          Thing: { type: 'object', properties: { a: { type: 'string' } } },
        },
      },
    };
    const out = toJsonSchema(doc, { $ref: '#/components/schemas/Thing' });
    expect(out['type']).toBe('object');
    expect(JSON.stringify(out)).not.toContain('$ref');
  });

  it('strips OpenAPI-only keywords', () => {
    const out = toJsonSchema(doc0(), {
      type: 'string',
      nullable: true,
      example: 'x',
    });
    expect(out['nullable']).toBeUndefined();
    expect(out['example']).toBeUndefined();
    expect(out['type']).toBe('string');
  });

  it('does not loop forever on a self-referential schema', () => {
    const doc: OpenApiDocument = {
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              child: { $ref: '#/components/schemas/Node' },
            },
          },
        },
      },
    };
    const out = toJsonSchema(doc, { $ref: '#/components/schemas/Node' });
    expect(out).toBeTruthy();
    expect(JSON.stringify(out)).toBeTruthy();
  });
});

function doc0(): OpenApiDocument {
  return {};
}
