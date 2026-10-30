#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Transports:
 *   (default)  stdio              — for Claude Desktop, Cursor, Cline
 *   --http     streamable HTTP    — for a hosted listing
 *
 * Flags:
 *   --http             serve over streamable HTTP instead of stdio
 *   --port <n>         HTTP port (default 8080)
 *   --host <addr>      HTTP bind address (default 127.0.0.1)
 *   --base-url <url>   override the remote service base URL
 *   --list-tools       print the tool list as JSON and exit (no server)
 *   --version          print the version and exit
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, MANIFEST } from './server.js';
import { configFromEnv } from './proxy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CliOptions {
  http: boolean;
  port: number;
  host: string;
  listTools: boolean;
  /** Print ONLY the tool counts, one number per line, for shell pipelines. */
  count: boolean;
  version: boolean;
  help: boolean;
  baseUrl?: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    http: false,
    port: 8080,
    host: '127.0.0.1',
    listTools: false,
    count: false,
    version: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--http':
        options.http = true;
        break;
      case '--port': {
        const value = Number(argv[i + 1]);
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`--port requires a positive number, got "${argv[i + 1]}"`);
        }
        options.port = value;
        i += 1;
        break;
      }
      case '--host': {
        const value = argv[i + 1];
        if (!value) throw new Error('--host requires an address');
        options.host = value;
        i += 1;
        break;
      }
      case '--base-url': {
        const value = argv[i + 1];
        if (!value) throw new Error('--base-url requires a URL');
        options.baseUrl = value;
        i += 1;
        break;
      }
      case '--list-tools':
        options.listTools = true;
        break;
      case '--count':
        options.count = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (arg && arg.startsWith('-')) {
          throw new Error(`Unknown flag "${arg}". Run with --help for usage.`);
        }
    }
  }
  return options;
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const USAGE = `synthex-mcp-server — MCP server for the Synthex Forge x402 paid catalogue

Usage:
  synthex-mcp-server                       stdio transport (default)
  synthex-mcp-server --http --port 8080    streamable HTTP transport
  synthex-mcp-server --list-tools          print the tool manifest and exit
  synthex-mcp-server --count               print paid/free/total tool counts

Options:
  --http              serve over streamable HTTP
  --port <n>          HTTP port (default 8080)
  --host <addr>       HTTP bind address (default 127.0.0.1)
  --base-url <url>    override the remote service base URL
  --list-tools        print the tool list as JSON and exit
  --count             print paid / free / total tool counts and exit
  --version           print the version and exit
  --help              show this help

Environment:
  SYNTHX_PAYER_PRIVATE_KEY   EIP-3009 payer key for x402 payments (never logged)
  SYNTHX_ALLOW_LIVE_SPEND    set to 1 to permit real on-chain payment (default: off)
  SYNTHX_BASE_URL            override the remote service base URL
  SYNTHX_TIMEOUT_MS          per-request timeout in ms (default 30000)
`;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  if (options.count) {
    // One number per line so a shell pipeline can read them directly.
    process.stdout.write(`${MANIFEST.paidToolCount}\n`);
    process.stdout.write(`${MANIFEST.freeToolCount}\n`);
    process.stdout.write(`${MANIFEST.paidToolCount + MANIFEST.freeToolCount}\n`);
    return;
  }
  if (options.listTools) {
    process.stdout.write(
      `${JSON.stringify(
        {
          paidToolCount: MANIFEST.paidToolCount,
          freeToolCount: MANIFEST.freeToolCount,
          totalToolCount: MANIFEST.paidToolCount + MANIFEST.freeToolCount,
          generatedAt: MANIFEST.generatedAt,
          source: MANIFEST.source,
          tools: MANIFEST.tools.map((t) => ({
            name: t.name,
            description: t.description,
            remote: `${t.endpoint.method} ${t.remotePath}`,
            price: `${t.pricing.amountUsd} ${t.pricing.currency}`,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const env = { ...process.env };
  if (options.baseUrl) env['SYNTHX_BASE_URL'] = options.baseUrl;
  const config = configFromEnv(env);

  if (!options.http) {
    const server = createServer(config);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // stdout is the protocol channel in stdio mode — diagnostics go to stderr.
    process.stderr.write(
      `synthex-mcp-server ready (stdio) — ${MANIFEST.paidToolCount} paid tools + 1 free\n`,
    );
    return;
  }

  const { createServer: createHttpServer } = await import('node:http');

  // STATELESS mode: `sessionIdGenerator: undefined`. The SDK requires a FRESH
  // transport (and a fresh Server bound to it) for EVERY request in stateless
  // mode — reusing one transport causes message-ID collisions between clients.
  // See @modelcontextprotocol/sdk server/webStandardStreamableHttp:
  // "In stateless mode (no sessionIdGenerator), each request must use a fresh
  // transport. Reusing a stateless transport causes message ID collisions."
  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      const requestServer = createServer(config);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      try {
        await requestServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            }),
          );
        }
        process.stderr.write(
          `synthex-mcp-server: request error: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      } finally {
        void transport.close();
        void requestServer.close();
      }
    })();
  });

  await new Promise<void>((resolvePromise) => {
    httpServer.listen(options.port, options.host, resolvePromise);
  });

  process.stderr.write(
    `synthex-mcp-server listening on http://${options.host}:${options.port}/mcp ` +
      `— ${MANIFEST.paidToolCount} paid tools + 1 free\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`synthex-mcp-server: ${message}\n`);
  process.exitCode = 1;
});
