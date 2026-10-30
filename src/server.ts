/**
 * The MCP server.
 *
 * Uses the low-level `Server` class from @modelcontextprotocol/sdk rather than
 * the higher-level `McpServer`, because the tool schemas come from a live
 * OpenAPI document as raw JSON Schema. `McpServer.registerTool` converts Zod
 * shapes into JSON Schema, which would require re-deriving 121 schemas in Zod
 * and would silently drop OpenAPI fidelity. The low-level API accepts the
 * JSON Schema verbatim.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import manifestJson from './generated/tools.manifest.json' with { type: 'json' };
import { callCatalogue, callPaidTool, type ProxyConfig } from './proxy.js';
import {
  FREE_TOOL_NAME,
  type JsonSchema,
  type ToolDefinition,
  type ToolManifest,
} from './types.js';

const SERVER_NAME = 'synthex-mcp-server';
const SERVER_VERSION = '1.0.0';

const INSTRUCTIONS = [
  'Synthex Forge x402 MCP server.',
  '',
  'Every paid tool proxies a REAL remote route on https://x402.synthexforge.com.',
  'Paid routes require x402 payment in USDC on Base mainnet (EIP-3009',
  'transferWithAuthorization). This server signs the authorization with the key in',
  'SYNTHX_PAYER_PRIVATE_KEY and returns the settlement transaction hash with the',
  'result.',
  '',
  'If a payer key is not configured, a paid call returns an isError result carrying',
  'the exact payment requirements. It is never silently stubbed.',
  '',
  'The `catalogue` tool is free: it reads the live public catalogue with no payment.',
].join('\n');

/** The committed tool manifest, loaded once at import time. */
export const MANIFEST = manifestJson as unknown as ToolManifest;

/** The free catalogue tool. Exactly one free tool ships in this package. */
const CATALOGUE_TOOL: Tool = {
  name: FREE_TOOL_NAME,
  title: 'Synthex Forge catalogue',
  description:
    'Read the LIVE Synthex Forge x402 catalogue: every route, its price, its rail ' +
    'and whether it is free or paid. No payment required — this is the free tool.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: {
    'synthex.io/free': true,
    'synthex.io/endpoint': { method: 'GET', path: '/.well-known/x402.json' },
  },
};

/** Convert an internal tool definition into the MCP `Tool` shape. */
export function toMcpTool(tool: ToolDefinition): Tool {
  const priceLabel = `${tool.pricing.amountUsd} ${tool.pricing.currency}`;
  return {
    name: tool.name,
    title: tool.description.slice(0, 120) || tool.name,
    description:
      `${tool.description}\n\n` +
      `Remote route: ${tool.endpoint.method} ${tool.remotePath} ` +
      `(${priceLabel} ${tool.pricing.rail} on ${tool.pricing.network}).`,
    inputSchema: tool.inputSchema as Tool['inputSchema'],
    ...(tool.outputSchema
      ? { outputSchema: tool.outputSchema as Tool['outputSchema'] }
      : {}),
    annotations: {
      readOnlyHint: tool.endpoint.method === 'GET',
      destructiveHint: false,
      idempotentHint: tool.endpoint.method === 'GET',
      openWorldHint: true,
    },
    _meta: {
      'synthex.io/price': {
        amount: tool.pricing.amountUsd,
        currency: tool.pricing.currency,
        amountAtomic: tool.pricing.amountAtomic,
        asset: tool.pricing.asset,
        assetSymbol: tool.pricing.assetSymbol,
        network: tool.pricing.network,
        payTo: tool.pricing.payTo,
        scheme: tool.pricing.scheme,
        rail: tool.pricing.rail,
      },
      'synthex.io/endpoint': {
        method: tool.endpoint.method,
        path: tool.endpoint.path,
        baseUrl: 'https://x402.synthexforge.com',
      },
      'synthex.io/operationId': tool.operationId,
      'synthex.io/paid': true,
    },
  };
}

/** The full tool list: every paid route plus the single free catalogue tool. */
export function buildToolList(manifest: ToolManifest = MANIFEST): Tool[] {
  return [...manifest.tools.map(toMcpTool), CATALOGUE_TOOL];
}

/**
 * Create the MCP server instance.
 *
 * Exported so tests can drive `tools/list` and `tools/call` directly without
 * spawning a transport.
 */
export function createServer(config: ProxyConfig): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  );

  const toolIndex = new Map<string, ToolDefinition>();
  for (const tool of MANIFEST.tools) {
    toolIndex.set(tool.name, tool);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolList(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === FREE_TOOL_NAME) {
      const outcome = await callCatalogue(config, args);
      if (outcome.status !== 200) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  error: 'catalogue_unavailable',
                  status: outcome.status,
                  body: outcome.body,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(outcome.body, null, 2) },
        ],
      };
    }

    const tool = toolIndex.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text:
              `Unknown tool "${name}". Call tools/list for the available tools ` +
              `(${MANIFEST.paidToolCount} paid + 1 free).`,
          },
        ],
      };
    }

    const outcome = await callPaidTool(tool, args, config);
    const payload: Record<string, unknown> = {
      status: outcome.status,
      tool: tool.name,
      remote: `${tool.endpoint.method} ${tool.remotePath}`,
    };
    if (outcome.paid) payload['payment'] = 'signed and submitted';
    if (outcome.settlement) {
      payload['settlement'] = outcome.settlement;
      if (outcome.settlement.transaction) {
        payload['settlement_tx'] = outcome.settlement.transaction;
      }
    }
    if (outcome.challenge) {
      payload['payment_required'] = outcome.challenge.accepts;
    }
    payload['result'] = outcome.body;

    const text = JSON.stringify(payload, null, 2);
    const isError =
      outcome.status >= 400 ||
      outcome.paymentRequiredWithoutKey ||
      (outcome.settlement !== null && outcome.settlement.success === false);

    return {
      ...(isError ? { isError: true } : {}),
      content: [{ type: 'text' as const, text }],
    };
  });

  return server;
}

/** Re-export the manifest type for consumers. */
export type { ToolManifest, ToolDefinition, JsonSchema };
export { z };
