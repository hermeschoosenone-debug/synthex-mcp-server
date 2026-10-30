/**
 * A local fixture server that speaks the REAL x402 v2 protocol.
 *
 * This is NOT a mock of the client's behaviour — it is a faithful stand-in for
 * the remote service's HTTP contract, so the client's 402 -> sign -> retry ->
 * settlement flow is exercised end to end without spending real USDC.
 *
 * It reproduces:
 *   - HTTP 402 with a base64 `PAYMENT-REQUIRED` header carrying `accepts`
 *   - HTTP 200 with a base64 `PAYMENT-RESPONSE` header carrying the settlement
 *     transaction hash, ONLY when a well-formed payment header is present
 *   - HTTP 402 (again) when the payment header is absent or malformed
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { decodePaymentResponseHeader } from '../../src/payment.js';

export interface FixtureOptions {
  /** Amount in atomic units the fixture demands. */
  readonly amountAtomic?: string;
  /** Settlement address the fixture declares. */
  readonly payTo?: string;
  /** When set, the fixture records every request it received. */
  readonly record?: boolean;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface Fixture {
  readonly url: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  /** Close the fixture server. */
  close(): Promise<void>;
}

function b64(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}

/** Read the full request body. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Start the fixture on an ephemeral port.
 *
 * Routes:
 *   GET  /.well-known/x402.json  -> 200 free catalogue
 *   POST /v1/paid                -> 402, then 200 once paid
 *   GET  /v1/paid                -> 402, then 200 once paid
 */
export async function startFixture(
  options: FixtureOptions = {},
): Promise<Fixture> {
  const amountAtomic = options.amountAtomic ?? '20000';
  const payTo = options.payTo ?? '0xc8fF67FAE72596478599EAAcfad8656fAe1113c8';
  const requests: RecordedRequest[] = [];

  const challenge = {
    x402Version: 2,
    error: 'Payment required',
    resource: {
      url: 'http://fixture.local/v1/paid',
      description: 'Fixture paid route.',
      mimeType: 'application/json',
      serviceName: 'x402 Receive',
      tags: ['fixture'],
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: amountAtomic,
        payTo,
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
      },
    ],
  };

  const settlementTx =
    '0x1111111111111111111111111111111111111111111111111111111111111111';

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const body = await readBody(req);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : (v ?? '');
        }
        requests.push({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers,
          body,
        });

        const url = req.url ?? '/';

        // Free catalogue route.
        if (url.startsWith('/.well-known/x402.json')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              x402Version: 2,
              serviceName: 'x402 Receive',
              counts: {
                paidEndpoints: 128,
                freeEndpoints: 140,
                totalPaths: 267,
                families: 12,
              },
              fixture: true,
            }),
          );
          return;
        }

        // Paid routes.
        const paymentHeader =
          headers['payment-signature'] ?? headers['x-payment'];

        if (!paymentHeader) {
          res.writeHead(402, {
            'content-type': 'application/json',
            'payment-required': b64(JSON.stringify(challenge)),
          });
          res.end(
            JSON.stringify({
              error: 'payment_required',
              error_reason: 'payment_required',
              error_message: 'payment required',
              x402Version: 2,
            }),
          );
          return;
        }

        // Decode the payment payload to confirm it is well formed.
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            Buffer.from(paymentHeader, 'base64').toString('utf-8'),
          );
        } catch {
          res.writeHead(402, {
            'content-type': 'application/json',
            'payment-required': b64(JSON.stringify(challenge)),
          });
          res.end(JSON.stringify({ error: 'payment_required' }));
          return;
        }

        const payload = parsed as {
          x402Version?: number;
          payload?: { authorization?: Record<string, unknown>; signature?: string };
          accepted?: Record<string, unknown>;
        };
        const authorization = payload.payload?.authorization;
        const signature = payload.payload?.signature;

        const wellFormed =
          payload.x402Version === 2 &&
          typeof signature === 'string' &&
          /^0x[0-9a-fA-F]{130}$/.test(signature) &&
          authorization !== undefined &&
          String(authorization['value']) === amountAtomic &&
          String(authorization['to']).toLowerCase() === payTo.toLowerCase();

        if (!wellFormed) {
          res.writeHead(402, {
            'content-type': 'application/json',
            'payment-required': b64(JSON.stringify(challenge)),
          });
          res.end(
            JSON.stringify({
              error: 'invalid_payment',
              error_reason: 'invalid_payment',
            }),
          );
          return;
        }

        res.writeHead(200, {
          'content-type': 'application/json',
          'payment-response': b64(
            JSON.stringify({
              success: true,
              transaction: settlementTx,
              network: 'eip155:8453',
              amount: amountAtomic,
              payer: String(authorization['from']),
            }),
          ),
        });
        res.end(
          JSON.stringify({
            status: 'ok',
            fixture: true,
            paid: true,
            amount_atomic: amountAtomic,
          }),
        );
      })();
    },
  );

  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    async close() {
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },
  };
}

/** Decode a `PAYMENT-RESPONSE` header from a recorded response. */
export function settlementFromHeader(
  headerValue: string | undefined,
): { success: boolean; transaction?: string } | null {
  return decodePaymentResponseHeader(headerValue);
}
