/**
 * The paid-call proxy.
 *
 * This is the ONLY place where a remote route is invoked. The flow is:
 *
 *   1. POST/GET the route.
 *   2. If 200 -> return the body. (The free surface, or a route that did not
 *      demand payment.)
 *   3. If 402 -> decode the `PAYMENT-REQUIRED` challenge.
 *        - No payer key configured -> return an isError result carrying the
 *          exact requirements and a one-line instruction. NEVER a stub.
 *        - Payer key configured -> sign an EIP-3009 authorization, retry with
 *          the payment headers, and return the body PLUS the settlement
 *          transaction hash from `PAYMENT-RESPONSE`.
 *
 * Live spend is gated behind `SYNTHX_ALLOW_LIVE_SPEND=1`, which is OFF by
 * default. Tests use a local fixture server, never the live endpoint.
 */

import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  paymentHeaders,
  resolvePayerKey,
  signEip3009,
  type PaymentChallenge,
  type PaymentRequirement,
  type SettlementReceipt,
} from './payment.js';
import {
  DEFAULT_BASE_URL,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  type ToolDefinition,
} from './types.js';

/** Configuration for the proxy. */
export interface ProxyConfig {
  /** Base URL of the remote service. */
  readonly baseUrl: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Allow a real on-chain payment. Default false. */
  readonly allowLiveSpend: boolean;
  /** Payer private key, or null when unconfigured. */
  readonly payerKey: string | null;
  /** Extra headers applied to every upstream request. */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
}

/** The outcome of a proxied call. */
export interface ProxyOutcome {
  /** HTTP status of the final upstream response. */
  readonly status: number;
  /** The parsed response body (JSON when possible, else raw text). */
  readonly body: unknown;
  /** The settlement receipt, when the service returned one. */
  readonly settlement: SettlementReceipt | null;
  /** True when the call was rejected because no payer key is configured. */
  readonly paymentRequiredWithoutKey: boolean;
  /** The decoded challenge, when a 402 was received. */
  readonly challenge: PaymentChallenge | null;
  /** Whether an actual payment was signed and submitted. */
  readonly paid: boolean;
}

/** Build the default proxy configuration from the environment. */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProxyConfig {
  const timeoutRaw = Number(env['SYNTHX_TIMEOUT_MS'] ?? '30000');
  return {
    baseUrl: (env['SYNTHX_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 30000,
    allowLiveSpend: env['SYNTHX_ALLOW_LIVE_SPEND'] === '1',
    payerKey: resolvePayerKey(env),
    ...(env['SYNTHX_DEFAULT_HEADERS']
      ? { defaultHeaders: JSON.parse(env['SYNTHX_DEFAULT_HEADERS']) as Record<string, string> }
      : {}),
  };
}

/** Split tool arguments into query params, body fields and header params. */
export function splitArguments(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): {
  query: Record<string, string>;
  body: Record<string, unknown>;
  headers: Record<string, string>;
} {
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};

  const bodySchema = tool.inputSchema as { properties?: Record<string, unknown> };
  const bodyProps = new Set(Object.keys(bodySchema.properties ?? {}));

  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined) continue;
    if (tool.endpoint.queryParams.includes(key)) {
      query[key] = String(value);
      continue;
    }
    if (tool.endpoint.headerParams.includes(key)) {
      headers[key] = String(value);
      continue;
    }
    // Everything else is a body field. For a GET route with no body, the
    // arguments still travel as query parameters.
    if (tool.endpoint.hasBody && bodyProps.has(key)) {
      body[key] = value;
    } else if (!tool.endpoint.hasBody) {
      query[key] = String(value);
    } else {
      body[key] = value;
    }
  }

  return { query, body, headers };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string>,
): string {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Invoke a paid tool on the remote service.
 *
 * Never throws for an HTTP-level failure — failures are returned as an
 * outcome so the MCP layer can render them as `isError` results with
 * actionable detail.
 */
export async function callPaidTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  config: ProxyConfig,
): Promise<ProxyOutcome> {
  const { query, body, headers } = splitArguments(tool, args);
  const url = buildUrl(config.baseUrl, tool.endpoint.path, query);

  const requestHeaders: Record<string, string> = {
    accept: 'application/json',
    ...(config.defaultHeaders ?? {}),
    ...headers,
  };

  const hasBody = tool.endpoint.hasBody && Object.keys(body).length > 0;
  if (hasBody && !tool.endpoint.multipart) {
    requestHeaders['content-type'] = 'application/json';
  }

  const makeRequest = (extraHeaders: Record<string, string>) =>
    fetch(url, {
      method: tool.endpoint.method,
      headers: { ...requestHeaders, ...extraHeaders },
      ...(hasBody
        ? {
            body: tool.endpoint.multipart
              ? toMultipart(body)
              : JSON.stringify(body),
          }
        : {}),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

  let response: Response;
  try {
    response = await makeRequest({});
  } catch (error) {
    return {
      status: 0,
      body: {
        error: 'upstream_unreachable',
        error_message: error instanceof Error ? error.message : String(error),
        url,
      },
      settlement: null,
      paymentRequiredWithoutKey: false,
      challenge: null,
      paid: false,
    };
  }

  if (response.status !== 402) {
    const parsed = await readBody(response);
    const settlement = decodePaymentResponseHeader(
      response.headers.get(PAYMENT_RESPONSE_HEADER),
    );
    return {
      status: response.status,
      body: parsed,
      settlement,
      paymentRequiredWithoutKey: false,
      challenge: null,
      paid: false,
    };
  }

  // --- 402: the route demands payment -----------------------------------
  let challenge: PaymentChallenge;
  try {
    challenge = decodePaymentRequiredHeader(
      response.headers.get(PAYMENT_REQUIRED_HEADER),
    );
  } catch (error) {
    return {
      status: 402,
      body: {
        error: 'payment_challenge_undecodable',
        error_message: error instanceof Error ? error.message : String(error),
        url,
      },
      settlement: null,
      paymentRequiredWithoutKey: false,
      challenge: null,
      paid: false,
    };
  }

  const requirement = pickRequirement(challenge);
  if (!requirement) {
    return {
      status: 402,
      body: {
        error: 'no_payment_requirement',
        error_message:
          'The 402 challenge did not advertise any payment requirement this client can satisfy.',
        challenge,
      },
      settlement: null,
      paymentRequiredWithoutKey: false,
      challenge,
      paid: false,
    };
  }

  if (!config.payerKey) {
    // No key: report the exact requirements and let the caller decide.
    // This is NEVER a stubbed success.
    return {
      status: 402,
      body: {
        error: 'payment_required',
        error_message:
          'This tool requires an x402 payment. Set SYNTHX_PAYER_PRIVATE_KEY to the ' +
          'payer key and retry, or call the route directly with your own payment.',
        url,
        payment_required: {
          scheme: requirement.scheme,
          network: requirement.network,
          asset: requirement.asset,
          amount_atomic: requirement.amount,
          pay_to: requirement.payTo,
          max_amount_required_atomic: requirement.amount,
          price_usd: tool.pricing.amountUsd,
          currency: tool.pricing.currency,
          rail: tool.pricing.rail,
        },
      },
      settlement: null,
      paymentRequiredWithoutKey: true,
      challenge,
      paid: false,
    };
  }

  if (!config.allowLiveSpend) {
    return {
      status: 402,
      body: {
        error: 'live_spend_disabled',
        error_message:
          'A payer key is configured but live spend is disabled. Set ' +
          'SYNTHX_ALLOW_LIVE_SPEND=1 to permit real on-chain payment.',
        url,
        payment_required: {
          scheme: requirement.scheme,
          network: requirement.network,
          asset: requirement.asset,
          amount_atomic: requirement.amount,
          pay_to: requirement.payTo,
          price_usd: tool.pricing.amountUsd,
          currency: tool.pricing.currency,
          rail: tool.pricing.rail,
        },
      },
      settlement: null,
      paymentRequiredWithoutKey: false,
      challenge,
      paid: false,
    };
  }

  // --- sign + retry ----------------------------------------------------
  const payload = await signEip3009(config.payerKey, requirement);
  let paidResponse: Response;
  try {
    paidResponse = await makeRequest(paymentHeaders(payload));
  } catch (error) {
    return {
      status: 0,
      body: {
        error: 'upstream_unreachable_after_payment',
        error_message: error instanceof Error ? error.message : String(error),
        url,
      },
      settlement: null,
      paymentRequiredWithoutKey: false,
      challenge,
      paid: false,
    };
  }

  const parsed = await readBody(paidResponse);
  const settlement = decodePaymentResponseHeader(
    paidResponse.headers.get(PAYMENT_RESPONSE_HEADER),
  );

  return {
    status: paidResponse.status,
    body: parsed,
    settlement,
    paymentRequiredWithoutKey: false,
    challenge,
    paid: true,
  };
}

/**
 * Choose the payment requirement to satisfy.
 *
 * Prefers an `exact` USDC requirement on Base mainnet — the only rail this
 * client settles.
 */
export function pickRequirement(
  challenge: PaymentChallenge,
): PaymentRequirement | null {
  if (challenge.accepts.length === 0) return null;
  const exact = challenge.accepts.find(
    (a) => a.scheme === 'exact' && a.network === 'eip155:8453',
  );
  return exact ?? challenge.accepts[0] ?? null;
}

/** Build a multipart/form-data body without pulling in a dependency. */
function toMultipart(fields: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Blob || value instanceof ArrayBuffer) {
      form.append(key, value as Blob);
    } else if (typeof value === 'object') {
      form.append(key, JSON.stringify(value));
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}

/**
 * Call the free catalogue route.
 *
 * This is the ONE free tool. It reads the public catalogue and requires no
 * payment, so a reviewer can prove the server works without spending.
 */
export async function callCatalogue(
  config: ProxyConfig,
  _args: Record<string, unknown> = {},
): Promise<ProxyOutcome> {
  const url = buildUrl(config.baseUrl, '/.well-known/x402.json', {});
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const parsed = await readBody(response);
    return {
      status: response.status,
      body: parsed,
      settlement: null,
      paymentRequiredWithoutKey: false,
      challenge: null,
      paid: false,
    };
  } catch (error) {
    return {
      status: 0,
      body: {
        error: 'catalogue_unreachable',
        error_message: error instanceof Error ? error.message : String(error),
        url,
      },
      settlement: null,
      paymentRequiredWithoutKey: false,
      challenge: null,
      paid: false,
    };
  }
}
