/**
 * Payment path tests.
 *
 * These prove the REAL x402 flow works end to end — 402 challenge, EIP-3009
 * signing, retry with the payment header, settlement receipt — against a LOCAL
 * fixture server. NO REAL USDC IS SPENT.
 *
 * The signer is a deterministic throwaway key. The fixture does not settle on
 * chain; it verifies the signature shape and amount, then returns a
 * `PAYMENT-RESPONSE` header carrying a transaction hash.
 */

import { describe, expect, it } from 'vitest';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  payerAddressFromKey,
  paymentHeaders,
  resolvePayerKey,
  signEip3009,
} from '../src/payment.js';
import { callPaidTool, pickRequirement, splitArguments } from '../src/proxy.js';
import { startFixture } from './fixtures/x402-server.js';
import type { ToolDefinition } from '../src/types.js';

/** A deterministic throwaway key. NOT a real payer, never funded. */
const TEST_KEY = `0x${'11'.repeat(32)}`;
const TEST_PAY_TO = '0xc8fF67FAE72596478599EAAcfad8656fAe1113c8';

function toolFor(path: string, amountUsd: string): ToolDefinition {
  return {
    name: 'test_paid_route',
    description: 'Fixture paid route.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
    endpoint: {
      method: 'POST',
      path,
      hasBody: true,
      multipart: false,
      queryParams: [],
      headerParams: [],
    },
    pricing: {
      amountUsd,
      currency: 'USD',
      amountAtomic: '20000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      assetSymbol: 'USDC',
      network: 'eip155:8453',
      payTo: TEST_PAY_TO,
      scheme: 'exact',
      rail: 'x402/base/usdc',
    },
    operationId: 'test_op',
    remotePath: path,
  };
}

describe('x402 challenge decoding', () => {
  it('decodes a base64 PAYMENT-REQUIRED header into the requirement', () => {
    const challenge = {
      x402Version: 2,
      error: 'Payment required',
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount: '20000',
          payTo: TEST_PAY_TO,
        },
      ],
    };
    const encoded = Buffer.from(JSON.stringify(challenge), 'utf-8').toString('base64');
    const decoded = decodePaymentRequiredHeader(encoded);
    expect(decoded.x402Version).toBe(2);
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0]?.amount).toBe('20000');
    expect(decoded.accepts[0]?.payTo).toBe(TEST_PAY_TO);
  });

  it('THROWS when the header is absent rather than inventing a requirement', () => {
    expect(() => decodePaymentRequiredHeader(undefined)).toThrow(/PAYMENT-REQUIRED/);
    expect(() => decodePaymentRequiredHeader(null)).toThrow(/PAYMENT-REQUIRED/);
  });

  it('THROWS on an undecodable header rather than defaulting to a price', () => {
    expect(() => decodePaymentRequiredHeader('not-base64-json!!!')).toThrow(
      /could not be decoded/,
    );
  });

  it('prefers an exact Base-USDC requirement', () => {
    const challenge = decodePaymentRequiredHeader(
      Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            { scheme: 'permit', network: 'eip155:1', amount: '1', payTo: '0x0' },
            {
              scheme: 'exact',
              network: 'eip155:8453',
              amount: '20000',
              payTo: TEST_PAY_TO,
            },
          ],
        }),
        'utf-8',
      ).toString('base64'),
    );
    expect(pickRequirement(challenge)?.scheme).toBe('exact');
    expect(pickRequirement(challenge)?.amount).toBe('20000');
  });

  it('returns null when the challenge advertises no requirement', () => {
    const challenge = decodePaymentRequiredHeader(
      Buffer.from(JSON.stringify({ x402Version: 2, accepts: [] }), 'utf-8').toString(
        'base64',
      ),
    );
    expect(pickRequirement(challenge)).toBeNull();
  });
});

describe('EIP-3009 signing', () => {
  it('produces a 65-byte signature over the exact requirement', async () => {
    const payload = await signEip3009(
      TEST_KEY,
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '20000',
        payTo: TEST_PAY_TO,
      },
      { validAfter: 1_700_000_000, validBefore: 1_800_000_000, nonce: `0x${'ab'.repeat(32)}` },
    );

    expect(payload.x402Version).toBe(2);
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(payload.payload.authorization.value).toBe('20000');
    expect(payload.payload.authorization.to.toLowerCase()).toBe(TEST_PAY_TO.toLowerCase());
    expect(payload.payload.authorization.from).toBe(payerAddressFromKey(TEST_KEY));
    expect(payload.payload.authorization.nonce).toBe(`0x${'ab'.repeat(32)}`);
    expect(payload.accepted.maxAmountRequired).toBe('20000');
  });

  it('NEVER contains the private key in the payload', async () => {
    const payload = await signEip3009(
      TEST_KEY,
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '20000',
        payTo: TEST_PAY_TO,
      },
    );
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain(TEST_KEY.slice(2));
    expect(serialised).not.toContain(TEST_KEY);
  });

  it('sends both the v2 and legacy payment headers', async () => {
    const payload = await signEip3009(
      TEST_KEY,
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '20000',
        payTo: TEST_PAY_TO,
      },
    );
    const headers = paymentHeaders(payload);
    expect(headers['PAYMENT-SIGNATURE']).toBeTruthy();
    expect(headers['X-PAYMENT']).toBe(headers['PAYMENT-SIGNATURE']);
  });
});

describe('payer key resolution', () => {
  it('returns null when the env var is unset or blank', () => {
    expect(resolvePayerKey({})).toBeNull();
    expect(resolvePayerKey({ SYNTHX_PAYER_PRIVATE_KEY: '' })).toBeNull();
    expect(resolvePayerKey({ SYNTHX_PAYER_PRIVATE_KEY: '   ' })).toBeNull();
  });

  it('normalises a key without the 0x prefix', () => {
    const key = resolvePayerKey({ SYNTHX_PAYER_PRIVATE_KEY: '11'.repeat(32) });
    expect(key).toBe(`0x${'11'.repeat(32)}`);
  });
});

describe('settlement receipt decoding', () => {
  it('decodes the transaction hash from a PAYMENT-RESPONSE header', () => {
    const encoded = Buffer.from(
      JSON.stringify({
        success: true,
        transaction: '0xabc123',
        network: 'eip155:8453',
        amount: '20000',
        payer: '0xdead',
      }),
      'utf-8',
    ).toString('base64');
    const decoded = decodePaymentResponseHeader(encoded);
    expect(decoded?.success).toBe(true);
    expect(decoded?.transaction).toBe('0xabc123');
  });

  it('returns null when the header is ABSENT — a 200 without it is not proof', () => {
    expect(decodePaymentResponseHeader(undefined)).toBeNull();
    expect(decodePaymentResponseHeader(null)).toBeNull();
    expect(decodePaymentResponseHeader('')).toBeNull();
  });
});

describe('paid call against the local x402 fixture (no real USDC spent)', () => {
  it('performs the full 402 -> sign -> pay -> settle flow and returns the tx hash', async () => {
    const fixture = await startFixture({ amountAtomic: '20000', payTo: TEST_PAY_TO });
    try {
      const outcome = await callPaidTool(
        toolFor('/v1/paid', '0.02'),
        { topic: 'hello' },
        {
          baseUrl: fixture.url,
          timeoutMs: 10_000,
          allowLiveSpend: true,
          payerKey: TEST_KEY,
        },
      );

      expect(outcome.status).toBe(200);
      expect(outcome.paid).toBe(true);
      expect(outcome.settlement?.success).toBe(true);
      expect(outcome.settlement?.transaction).toMatch(/^0x[0-9a-f]{64}$/);

      // Two upstream requests: the unpaid probe, then the paid retry.
      expect(fixture.requests).toHaveLength(2);
      const retry = fixture.requests[1];
      expect(retry?.headers['payment-signature']).toBeTruthy();
      expect(retry?.body).toContain('hello');
    } finally {
      await fixture.close();
    }
  });

  it('returns the payment requirements, NOT a stub, when no payer key is set', async () => {
    const fixture = await startFixture({ amountAtomic: '20000', payTo: TEST_PAY_TO });
    try {
      const outcome = await callPaidTool(
        toolFor('/v1/paid', '0.02'),
        { topic: 'hello' },
        {
          baseUrl: fixture.url,
          timeoutMs: 10_000,
          allowLiveSpend: true,
          payerKey: null,
        },
      );

      expect(outcome.status).toBe(402);
      expect(outcome.paymentRequiredWithoutKey).toBe(true);
      expect(outcome.paid).toBe(false);
      expect(outcome.settlement).toBeNull();

      const body = outcome.body as Record<string, unknown>;
      expect(body['error']).toBe('payment_required');
      const requirements = body['payment_required'] as Record<string, unknown>;
      expect(requirements['amount_atomic']).toBe('20000');
      expect(requirements['pay_to']).toBe(TEST_PAY_TO);
      expect(String(body['error_message'])).toMatch(/SYNTHX_PAYER_PRIVATE_KEY/);

      // Exactly ONE upstream request — no retry was attempted.
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it('refuses to spend when live spend is disabled, even with a key configured', async () => {
    const fixture = await startFixture({ amountAtomic: '20000', payTo: TEST_PAY_TO });
    try {
      const outcome = await callPaidTool(
        toolFor('/v1/paid', '0.02'),
        { topic: 'hello' },
        {
          baseUrl: fixture.url,
          timeoutMs: 10_000,
          allowLiveSpend: false,
          payerKey: TEST_KEY,
        },
      );

      expect(outcome.status).toBe(402);
      expect(outcome.paid).toBe(false);
      const body = outcome.body as Record<string, unknown>;
      expect(body['error']).toBe('live_spend_disabled');
      expect(fixture.requests).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it('reports an unreachable upstream instead of throwing', async () => {
    const outcome = await callPaidTool(
      toolFor('/v1/paid', '0.02'),
      {},
      {
        // Port 1 is not listening.
        baseUrl: 'http://127.0.0.1:1',
        timeoutMs: 2_000,
        allowLiveSpend: false,
        payerKey: null,
      },
    );
    expect(outcome.status).toBe(0);
    const body = outcome.body as Record<string, unknown>;
    expect(body['error']).toBe('upstream_unreachable');
  });
});

describe('argument routing', () => {
  it('splits query params, header params and body fields', () => {
    const tool: ToolDefinition = {
      ...toolFor('/v1/thing', '0.02'),
      endpoint: {
        method: 'POST',
        path: '/v1/thing',
        hasBody: true,
        multipart: false,
        queryParams: ['topic'],
        headerParams: ['Idempotency-Key'],
      },
    };
    const split = splitArguments(tool, {
      topic: 'x',
      'Idempotency-Key': 'abc',
      bodyField: 'y',
    });
    expect(split.query).toEqual({ topic: 'x' });
    expect(split.headers).toEqual({ 'Idempotency-Key': 'abc' });
    expect(split.body).toEqual({ bodyField: 'y' });
  });

  it('sends all arguments as query params for a body-less GET route', () => {
    const tool: ToolDefinition = {
      ...toolFor('/v1/get', '0.02'),
      endpoint: {
        method: 'GET',
        path: '/v1/get',
        hasBody: false,
        multipart: false,
        queryParams: ['q'],
        headerParams: [],
      },
    };
    const split = splitArguments(tool, { q: 'hello' });
    expect(split.query).toEqual({ q: 'hello' });
    expect(split.body).toEqual({});
  });
});
