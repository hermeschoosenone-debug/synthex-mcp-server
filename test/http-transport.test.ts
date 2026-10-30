/**
 * Streamable HTTP transport regression test.
 *
 * BUG THIS GUARDS AGAINST: in stateless mode the SDK requires a FRESH
 * transport (and a fresh Server bound to it) for every request. Reusing one
 * transport across requests makes the second request fail with HTTP 500
 * ("message ID collisions"), which silently breaks every hosted client that
 * sends more than one request.
 *
 * The test drives the real CLI over real HTTP with the real MCP client, and
 * asserts that THREE requests all succeed on the same server process.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = 8127;
const ENDPOINT = `http://127.0.0.1:${PORT}/mcp`;

let serverProc: ChildProcess;

async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(ENDPOINT, { method: 'GET' });
      // Any HTTP answer means the listener is up.
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('HTTP MCP server did not start in time');
}

beforeAll(async () => {
  serverProc = spawn(
    process.execPath,
    [resolve(ROOT, 'dist/cli.js'), '--http', '--port', String(PORT)],
    {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SYNTHX_PAYER_PRIVATE_KEY: '', SYNTHX_ALLOW_LIVE_SPEND: '' },
    },
  );
  serverProc.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    if (text.includes('EADDRINUSE') || text.includes('Error')) {
      process.stderr.write(`[server] ${text}`);
    }
  });
  await waitForServer();
}, 40_000);

afterAll(() => {
  serverProc?.kill('SIGTERM');
});

describe('streamable HTTP transport', () => {
  it('serves three consecutive requests on one server process', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    await client.connect(transport);

    // Request 1: tools/list
    const list = await client.listTools();
    expect(list.tools.length).toBeGreaterThan(1);

    // Request 2: a free tool call — this is the request that failed with a
    // 500 when a single stateless transport was reused.
    const call = await client.callTool({ name: 'catalogue', arguments: {} });
    expect(call.isError).toBeFalsy();

    // Request 3: tools/list again — proves the transport is still healthy
    // after a tool call, not just after the first request.
    const listAgain = await client.listTools();
    expect(listAgain.tools.length).toBe(list.tools.length);

    await client.close();
  });

  it('returns a JSON-RPC error, not a crash, for an unknown tool', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT));
    const client = new Client({ name: 'http-test-2', version: '1.0.0' });
    await client.connect(transport);

    const result = await client.callTool({
      name: 'not_a_real_tool',
      arguments: {},
    });
    expect(result.isError).toBe(true);

    await client.close();
  });
});
