/**
 * Server-level tests: tools/list and tools/call over the real MCP protocol.
 *
 * These drive the actual @modelcontextprotocol/sdk Server instance through an
 * in-memory transport pair, so the request/response handling under test is the
 * same code path a stdio or HTTP client exercises.
 */

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, MANIFEST } from '../src/server.js';
import { configFromEnv } from '../src/proxy.js';
import { startFixture } from './fixtures/x402-server.js';
import { FREE_TOOL_NAME } from '../src/types.js';

async function connect(baseUrl: string) {
  const config = configFromEnv({
    SYNTHX_BASE_URL: baseUrl,
    SYNTHX_TIMEOUT_MS: '10000',
  });
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, server };
}

describe('MCP server', () => {
  it('lists every paid tool plus the free catalogue tool', async () => {
    const fixture = await startFixture();
    try {
      const { client } = await connect(fixture.url);
      const result = await client.listTools();
      expect(result.tools).toHaveLength(MANIFEST.paidToolCount + 1);
      const names = result.tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain(FREE_TOOL_NAME);
      await client.close();
    } finally {
      await fixture.close();
    }
  });

  it('advertises the price on every paid tool', async () => {
    const fixture = await startFixture();
    try {
      const { client } = await connect(fixture.url);
      const result = await client.listTools();
      const paid = result.tools.filter((t) => t.name !== FREE_TOOL_NAME);
      expect(paid).toHaveLength(MANIFEST.paidToolCount);
      for (const tool of paid) {
        const meta = tool._meta as Record<string, unknown> | undefined;
        expect(meta?.['synthex.io/price']).toBeDefined();
      }
      await client.close();
    } finally {
      await fixture.close();
    }
  });

  it('calls the FREE catalogue tool and returns real JSON', async () => {
    const fixture = await startFixture();
    try {
      const { client } = await connect(fixture.url);
      const result = await client.callTool({
        name: FREE_TOOL_NAME,
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed['fixture']).toBe(true);
      expect(parsed['counts']).toBeDefined();
      await client.close();
    } finally {
      await fixture.close();
    }
  });

  it('returns isError for an unknown tool rather than throwing', async () => {
    const fixture = await startFixture();
    try {
      const { client } = await connect(fixture.url);
      const result = await client.callTool({
        name: 'definitely_not_a_tool',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text).toMatch(/Unknown tool/);
      await client.close();
    } finally {
      await fixture.close();
    }
  });

  it('returns an isError result with the payment requirements when no key is set', async () => {
    const fixture = await startFixture();
    try {
      const { client } = await connect(fixture.url);
      const result = await client.callTool({
        name: MANIFEST.tools[0]!.name,
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed['status']).toBe(402);
      const body = parsed['result'] as Record<string, unknown>;
      expect(body['error']).toBe('payment_required');
      expect(body['payment_required']).toBeDefined();
      await client.close();
    } finally {
      await fixture.close();
    }
  });
});
