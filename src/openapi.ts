/**
 * OpenAPI -> MCP tool manifest conversion.
 *
 * This module is deliberately PURE (no network, no filesystem) so it can be
 * unit-tested offline against the committed OpenAPI snapshot. The network
 * fetch lives in scripts/generate-manifest.ts.
 *
 * Every paid route in the source document becomes exactly one MCP tool. The
 * mapping is 1:1 and total: no route is dropped, merged or invented.
 */

import type { JsonSchema, ToolDefinition, ToolEndpoint, ToolPricing } from './types.js';

/** Minimal shape of the OpenAPI document we consume. */
export interface OpenApiDocument {
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

function isHttpMethod(k: string): k is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(k.toUpperCase());
}

/**
 * Resolve a local `#/components/schemas/...` reference.
 *
 * Only local refs are supported (the remote spec uses only these). A ref that
 * cannot be resolved returns undefined so the caller can record a diagnostic
 * rather than silently emitting a broken schema.
 */
export function resolveRef(
  doc: OpenApiDocument,
  ref: string,
): JsonSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  const parts = ref.slice(2).split('/');
  let cursor: unknown = doc as unknown;
  for (const part of parts) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  if (cursor === null || typeof cursor !== 'object') return undefined;
  return cursor as JsonSchema;
}

/** True when the schema (or any nested schema) carries a `$ref`. */
export function hasRef(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const s = schema as Record<string, unknown>;
  if (typeof s['$ref'] === 'string') return true;
  for (const key of ['items', 'not', 'additionalProperties']) {
    if (hasRef(s[key])) return true;
  }
  for (const key of ['properties', 'patternProperties', 'definitions']) {
    const v = s[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const sub of Object.values(v as Record<string, unknown>)) {
        if (hasRef(sub)) return true;
      }
    }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const v = s[key];
    if (Array.isArray(v)) {
      for (const sub of v) if (hasRef(sub)) return true;
    }
  }
  return false;
}

/**
 * Strip OpenAPI-only keywords that are meaningless (or invalid) in MCP's
 * JSON Schema dialect, and inline all local `$ref`s.
 *
 * MCP clients validate tool arguments with a JSON Schema validator. OpenAPI's
 * `nullable`, `example`, `exclusiveMinimum` as a bool, and `discriminator` are
 * not part of JSON Schema, so they are removed rather than passed through
 * (a validator may reject the whole schema).
 */
export function toJsonSchema(doc: OpenApiDocument, schema: unknown, seen = new Set<string>()): JsonSchema {
  if (schema === null || typeof schema !== 'object') return {};
  const src = schema as Record<string, unknown>;

  if (typeof src['$ref'] === 'string') {
    const ref = src['$ref'] as string;
    // Cycle guard: a self-referential schema resolves to an open object.
    if (seen.has(ref)) return { type: 'object', additionalProperties: true };
    const resolved = resolveRef(doc, ref);
    if (!resolved) return { type: 'object', additionalProperties: true };
    const nextSeen = new Set(seen);
    nextSeen.add(ref);
    const merged = { ...src };
    delete merged['$ref'];
    return {
      ...toJsonSchema(doc, resolved, nextSeen),
      ...toJsonSchema(doc, merged, nextSeen),
    };
  }

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(src)) {
    switch (key) {
      // OpenAPI-isms, not JSON Schema.
      case 'nullable':
      case 'example':
      case 'discriminator':
      case 'xml':
      case 'externalDocs':
      case 'deprecated':
        continue;
      // OpenAPI 3.0 uses a boolean exclusiveMinimum/Maximum; JSON Schema 2020-12
      // uses a number. The remote spec does not use these, but normalise if seen.
      case 'exclusiveMinimum':
      case 'exclusiveMaximum':
        if (typeof value === 'boolean') continue;
        out[key] = value;
        continue;
      default:
        break;
    }

    if (key === 'properties' || key === 'patternProperties' || key === 'definitions') {
      const map = value as Record<string, unknown> | undefined;
      if (!map || typeof map !== 'object') continue;
      const converted: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(map)) {
        converted[propName] = toJsonSchema(doc, propSchema, seen);
      }
      out[key] = converted;
      continue;
    }

    if (key === 'items') {
      out[key] = toJsonSchema(doc, value, seen);
      continue;
    }

    if (key === 'additionalProperties') {
      if (typeof value === 'boolean') {
        out[key] = value;
      } else {
        out[key] = toJsonSchema(doc, value, seen);
      }
      continue;
    }

    if (key === 'allOf' || key === 'anyOf' || key === 'oneOf') {
      const list = Array.isArray(value) ? value : [];
      out[key] = list.map((s) => toJsonSchema(doc, s, seen));
      continue;
    }

    if (key === 'not') {
      out[key] = toJsonSchema(doc, value, seen);
      continue;
    }

    out[key] = value;
  }
  return out;
}

/**
 * Build a stable, collision-free tool name from a route path + method.
 *
 * Stability matters: the name is the tool's identity in every MCP client, so
 * it must not change when unrelated routes are added. The slug is derived from
 * the path only (not the method) — the current catalogue has no path with two
 * paid methods, and the generator asserts that, so path-only is stable and
 * readable.
 */
export function slugify(method: HttpMethod, path: string): string {
  const base = path
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const slug = base.length > 0 ? base : 'root';
  // MCP tool names should match ^[a-zA-Z0-9_-]{1,64}$.
  const trimmed = slug.slice(0, 64);
  return /^[a-zA-Z_]/.test(trimmed) ? trimmed : `x_${trimmed}`;
}

/** A paid route as discovered in the OpenAPI document. */
export interface DiscoveredRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly requestSchema?: JsonSchema;
  readonly responseSchema?: JsonSchema;
  readonly queryParams: readonly string[];
  readonly headerParams: readonly string[];
  readonly hasBody: boolean;
  readonly multipart: boolean;
  readonly pricing: ToolPricing;
}

function pricingFromPaymentInfo(
  paymentInfo: Record<string, unknown>,
  op: Record<string, unknown>,
): ToolPricing {
  const price = (paymentInfo['price'] ?? {}) as Record<string, unknown>;
  const accepts = paymentInfo as unknown as {
    amount?: string;
    maxAmountRequired?: string;
    network?: string;
    asset?: string;
    assetSymbol?: string;
    payTo?: string;
    scheme?: string;
  };
  const amountAtomic = String(
    accepts.maxAmountRequired ?? accepts.amount ?? price['amount'] ?? '0',
  );
  const amountUsd = String(price['amount'] ?? price['amountAtomic'] ?? '0');
  return {
    amountUsd,
    currency: String(price['currency'] ?? 'USD'),
    amountAtomic,
    asset: String(accepts.asset ?? price['asset'] ?? ''),
    assetSymbol: String(accepts.assetSymbol ?? 'USDC'),
    network: String(accepts.network ?? 'eip155:8453'),
    payTo: String(accepts.payTo ?? ''),
    scheme: String(accepts.scheme ?? 'exact'),
    rail: String(op['x-price-rail'] ?? 'x402/base/usdc'),
  };
}

/**
 * Discover every paid route in an OpenAPI document.
 *
 * A route is "paid" when its operation carries `x-payment-info`. This is the
 * same marker the remote service uses to decide whether to return a 402, so
 * the set of tools is exactly the set of routes that require payment.
 */
export function discoverPaidRoutes(doc: OpenApiDocument): DiscoveredRoute[] {
  const paths = doc.paths ?? {};
  const found: DiscoveredRoute[] = [];

  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [rawMethod, rawOp] of Object.entries(pathItem)) {
      if (!isHttpMethod(rawMethod)) continue;
      const op = rawOp as Record<string, unknown>;
      const paymentInfo = op['x-payment-info'];
      if (!paymentInfo || typeof paymentInfo !== 'object') continue;

      const method = rawMethod.toUpperCase() as HttpMethod;
      const parameters = Array.isArray(op['parameters'])
        ? (op['parameters'] as Record<string, unknown>[])
        : [];
      const queryParams: string[] = [];
      const headerParams: string[] = [];
      for (const p of parameters) {
        const name = String(p['name'] ?? '');
        const where = String(p['in'] ?? '');
        if (!name) continue;
        if (where === 'query') queryParams.push(name);
        else if (where === 'header') headerParams.push(name);
      }

      let requestSchema: JsonSchema | undefined;
      let hasBody = false;
      let multipart = false;
      const requestBody = op['requestBody'] as Record<string, unknown> | undefined;
      if (requestBody && typeof requestBody === 'object') {
        const content = (requestBody['content'] ?? {}) as Record<string, unknown>;
        const jsonContent = content['application/json'] as
          | Record<string, unknown>
          | undefined;
        const multipartContent = content['multipart/form-data'] as
          | Record<string, unknown>
          | undefined;
        if (jsonContent && typeof jsonContent === 'object') {
          hasBody = true;
          requestSchema = toJsonSchema(
            doc,
            (jsonContent['schema'] as unknown) ?? {},
          );
        } else if (multipartContent && typeof multipartContent === 'object') {
          hasBody = true;
          multipart = true;
          requestSchema = toJsonSchema(
            doc,
            (multipartContent['schema'] as unknown) ?? {},
          );
        }
      }

      let responseSchema: JsonSchema | undefined;
      const responses = (op['responses'] ?? {}) as Record<string, unknown>;
      const ok = responses['200'] as Record<string, unknown> | undefined;
      if (ok && typeof ok === 'object') {
        const content = (ok['content'] ?? {}) as Record<string, unknown>;
        const jsonContent = content['application/json'] as
          | Record<string, unknown>
          | undefined;
        if (jsonContent && typeof jsonContent === 'object') {
          responseSchema = toJsonSchema(
            doc,
            (jsonContent['schema'] as unknown) ?? {},
          );
        }
      }

      found.push({
        method,
        path: rawPath,
        operationId: String(op['operationId'] ?? ''),
        summary: String(op['summary'] ?? ''),
        description: String(op['description'] ?? ''),
        ...(requestSchema ? { requestSchema } : {}),
        ...(responseSchema ? { responseSchema } : {}),
        queryParams,
        headerParams,
        hasBody,
        multipart,
        pricing: pricingFromPaymentInfo(
          paymentInfo as Record<string, unknown>,
          op,
        ),
      });
    }
  }

  found.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
  return found;
}

/**
 * Convert discovered routes into MCP tool definitions.
 *
 * Throws when two routes would produce the same tool name — a silent
 * collision would make one route unreachable, so it must be a hard error.
 */
export function routesToTools(routes: readonly DiscoveredRoute[]): ToolDefinition[] {
  const seen = new Map<string, string>();
  const tools: ToolDefinition[] = [];

  for (const route of routes) {
    const name = slugify(route.method, route.path);
    const previous = seen.get(name);
    if (previous) {
      throw new Error(
        `tool name collision: "${name}" produced by both ${previous} and ${route.method} ${route.path}`,
      );
    }
    seen.set(name, `${route.method} ${route.path}`);

    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    if (route.requestSchema && typeof route.requestSchema === 'object') {
      const props = route.requestSchema['properties'];
      if (props && typeof props === 'object') {
        Object.assign(properties, props as Record<string, unknown>);
      }
      const req = route.requestSchema['required'];
      if (Array.isArray(req)) {
        for (const r of req) if (typeof r === 'string') required.push(r);
      }
    }

    // Query parameters for GET routes are part of the tool's input.
    for (const q of route.queryParams) {
      if (!(q in properties)) {
        properties[q] = { type: 'string', description: `Query parameter \`${q}\`.` };
      }
    }

    const inputSchema: JsonSchema = {
      type: 'object',
      properties,
    };
    if (required.length > 0) inputSchema['required'] = required;

    const endpoint: ToolEndpoint = {
      method: route.method,
      path: route.path,
      hasBody: route.hasBody,
      multipart: route.multipart,
      queryParams: route.queryParams,
      headerParams: route.headerParams,
    };

    const description =
      route.summary ||
      route.description ||
      `${route.method} ${route.path}`;

    const tool: ToolDefinition = {
      name,
      description,
      inputSchema,
      ...(route.responseSchema ? { outputSchema: route.responseSchema } : {}),
      endpoint,
      pricing: route.pricing,
      operationId: route.operationId,
      remotePath: route.path,
    };
    tools.push(tool);
  }

  return tools;
}
