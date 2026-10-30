/**
 * x402 payment: challenge decoding and EIP-3009 (EIP-712) signing.
 *
 * SECURITY RULES enforced here:
 *  - The private key is read from the environment ONLY. It is never logged,
 *    never returned inside a payload, never written to disk.
 *  - `signEip3009` returns a payload that contains the payer's PUBLIC address
 *    and a signature. It never contains the key.
 *  - No live spend happens unless the caller explicitly enables it.
 */

import {
  encodeFunctionData,
  formatUnits,
  hashTypedData,
  hexToBigInt,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  CHAIN_ID,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOKEN_NAME,
  TOKEN_VERSION,
  USDC_BASE,
  X_PAYMENT_HEADER,
} from './types.js';

/** The EIP-712 domain of the USDC contract on Base mainnet. */
export const EIP712_DOMAIN = {
  name: TOKEN_NAME,
  version: TOKEN_VERSION,
  chainId: CHAIN_ID,
  verifyingContract: USDC_BASE,
} as const;

/** EIP-3009 `TransferWithAuthorization` field types. */
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** One payment option advertised by the remote service in its 402 challenge. */
export interface PaymentRequirement {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds?: number;
  readonly extra?: Record<string, unknown>;
}

/** The decoded x402 v2 `payment-required` challenge. */
export interface PaymentChallenge {
  readonly x402Version: number;
  readonly error?: string;
  readonly resource?: {
    readonly url?: string;
    readonly description?: string;
    readonly mimeType?: string;
    readonly serviceName?: string;
    readonly tags?: readonly string[];
  };
  readonly accepts: readonly PaymentRequirement[];
}

/** The x402 v2 payment payload sent back to the remote service. */
export interface PaymentPayload {
  readonly x402Version: number;
  readonly payload: {
    readonly authorization: {
      readonly from: string;
      readonly to: string;
      readonly value: string;
      readonly valid_after: string;
      readonly valid_before: string;
      readonly nonce: string;
    };
    readonly signature: string;
  };
  readonly accepted: {
    readonly scheme: string;
    readonly network: string;
    readonly maxAmountRequired: string;
  };
}

/** The decoded x402 `PAYMENT-RESPONSE` settlement receipt. */
export interface SettlementReceipt {
  readonly success: boolean;
  readonly transaction?: string;
  readonly network?: string;
  readonly amount?: string;
  readonly payer?: string;
  readonly errorReason?: string;
  readonly errorMessage?: string;
}

function b64urlDecode(value: string): string {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalised, 'base64').toString('utf-8');
}

function b64urlEncode(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64');
}

/**
 * Decode a `PAYMENT-REQUIRED` header (base64 JSON) into a challenge.
 *
 * Throws when the header is absent or unparseable — the caller must not
 * silently treat "no challenge" as "payment succeeded".
 */
export function decodePaymentRequiredHeader(
  headerValue: string | undefined | null,
): PaymentChallenge {
  if (!headerValue) {
    throw new Error(
      `The service returned 402 without a \`${PAYMENT_REQUIRED_HEADER}\` header. ` +
        'Cannot determine the payment requirements.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(headerValue));
  } catch {
    try {
      parsed = JSON.parse(headerValue);
    } catch {
      throw new Error(
        `The \`${PAYMENT_REQUIRED_HEADER}\` header could not be decoded as base64 JSON.`,
      );
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('The `PAYMENT-REQUIRED` header did not contain a JSON object.');
  }
  const doc = parsed as Record<string, unknown>;
  const acceptsRaw = Array.isArray(doc['accepts']) ? doc['accepts'] : [];
  const accepts: PaymentRequirement[] = acceptsRaw.map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      scheme: String(e['scheme'] ?? 'exact'),
      network: String(e['network'] ?? `eip155:${CHAIN_ID}`),
      asset: String(e['asset'] ?? USDC_BASE),
      amount: String(e['amount'] ?? e['maxAmountRequired'] ?? '0'),
      payTo: String(e['payTo'] ?? ''),
      ...(typeof e['maxTimeoutSeconds'] === 'number'
        ? { maxTimeoutSeconds: e['maxTimeoutSeconds'] }
        : {}),
      ...(e['extra'] && typeof e['extra'] === 'object'
        ? { extra: e['extra'] as Record<string, unknown> }
        : {}),
    };
  });
  const resourceRaw = doc['resource'];
  const resource =
    resourceRaw && typeof resourceRaw === 'object'
      ? (resourceRaw as Record<string, unknown>)
      : undefined;
  return {
    x402Version: Number(doc['x402Version'] ?? 2),
    ...(typeof doc['error'] === 'string' ? { error: doc['error'] } : {}),
    ...(resource
      ? {
          resource: {
            ...(typeof resource['url'] === 'string' ? { url: resource['url'] } : {}),
            ...(typeof resource['description'] === 'string'
              ? { description: resource['description'] }
              : {}),
            ...(typeof resource['mimeType'] === 'string'
              ? { mimeType: resource['mimeType'] }
              : {}),
            ...(typeof resource['serviceName'] === 'string'
              ? { serviceName: resource['serviceName'] }
              : {}),
            ...(Array.isArray(resource['tags'])
              ? { tags: resource['tags'] as string[] }
              : {}),
          },
        }
      : {}),
    accepts,
  };
}

/** Encode a settlement receipt header value (base64 JSON). */
export function encodePaymentResponseHeader(receipt: SettlementReceipt): string {
  return b64urlEncode(JSON.stringify(receipt));
}

/**
 * Decode a `PAYMENT-RESPONSE` header into a settlement receipt.
 *
 * Returns null when the header is absent — a 200 without a settlement header
 * is NOT proof of payment and must be reported as such.
 */
export function decodePaymentResponseHeader(
  headerValue: string | undefined | null,
): SettlementReceipt | null {
  if (!headerValue) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(headerValue));
  } catch {
    try {
      parsed = JSON.parse(headerValue);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const d = parsed as Record<string, unknown>;
  return {
    success: Boolean(d['success']),
    ...(typeof d['transaction'] === 'string' ? { transaction: d['transaction'] } : {}),
    ...(typeof d['network'] === 'string' ? { network: d['network'] } : {}),
    ...(typeof d['amount'] === 'string' ? { amount: d['amount'] } : {}),
    ...(typeof d['payer'] === 'string' ? { payer: d['payer'] } : {}),
    ...(typeof d['error_reason'] === 'string' ? { errorReason: d['error_reason'] } : {}),
    ...(typeof d['errorMessage'] === 'string'
      ? { errorMessage: d['errorMessage'] }
      : {}),
  };
}

/** Headers that carry the signed payment payload to the remote service. */
export function paymentHeaders(payload: PaymentPayload): Record<string, string> {
  const encoded = b64urlEncode(JSON.stringify(payload));
  return {
    [PAYMENT_SIGNATURE_HEADER]: encoded,
    // v1 legacy header, sent alongside for maximum compatibility.
    [X_PAYMENT_HEADER]: encoded,
  };
}

/**
 * Resolve the payer private key from the environment.
 *
 * Returns null when unset. The key is NEVER logged and never returned in any
 * payload — only the derived public address leaves this function.
 */
export function resolvePayerKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['SYNTHX_PAYER_PRIVATE_KEY'];
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

/** Derive the public payer address from a private key. Never logs the key. */
export function payerAddressFromKey(privateKey: string): Address {
  return privateKeyToAccount(privateKey as Hex).address;
}

/**
 * Sign an EIP-3009 `transferWithAuthorization` for the given requirement.
 *
 * The returned payload carries the payer's public address and a 65-byte
 * signature. The private key is not part of the return value.
 */
export async function signEip3009(
  privateKey: string,
  requirement: PaymentRequirement,
  opts: { validAfter?: number; validBefore?: number; nonce?: string } = {},
): Promise<PaymentPayload> {
  const account = privateKeyToAccount(privateKey as Hex);
  const now = Math.floor(Date.now() / 1000);
  const validAfter = opts.validAfter ?? now - 60;
  const validBefore = opts.validBefore ?? now + 3600;
  const nonce =
    opts.nonce ??
    (`0x${Buffer.from(
      globalThis.crypto.getRandomValues(new Uint8Array(32)),
    ).toString('hex')}` as Hex);

  const value = BigInt(requirement.amount);

  const domain = {
    name: EIP712_DOMAIN.name,
    version: EIP712_DOMAIN.version,
    chainId: EIP712_DOMAIN.chainId,
    verifyingContract: EIP712_DOMAIN.verifyingContract as Address,
  };
  const message = {
    from: account.address,
    to: requirement.payTo as Address,
    value,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonce as Hex,
  };

  // `hashTypedData` is synchronous; `account.sign` is async in viem 2.x.
  const digest = hashTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message,
  });
  const signature = await account.sign({ hash: digest });

  return {
    x402Version: 2,
    payload: {
      authorization: {
        from: account.address,
        to: requirement.payTo,
        value: String(value),
        valid_after: String(validAfter),
        valid_before: String(validBefore),
        nonce,
      },
      signature,
    },
    accepted: {
      scheme: requirement.scheme,
      network: requirement.network,
      maxAmountRequired: String(value),
    },
  };
}

/** Human-readable amount for logging and for tool metadata. */
export function describeAmount(amountAtomic: string, decimals = 6): string {
  try {
    return formatUnits(hexToBigInt(`0x${BigInt(amountAtomic).toString(16)}`), decimals);
  } catch {
    return amountAtomic;
  }
}

/** Convert a USD price string to atomic units. */
export function usdToAtomic(usd: string, decimals = 6): string {
  return String(parseUnits(usd, decimals));
}

/** Base RPC endpoint used for optional receipt verification. */
export function defaultRpcUrl(): string {
  return process.env['SYNTHX_BASE_RPC_URL'] ?? 'https://mainnet.base.org';
}

/** Encode an ERC-20 `transferWithAuthorization` call (settlement tooling). */
export function encodeTransferWithAuthorization(args: {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
}): Hex {
  return encodeFunctionData({
    abi: [
      {
        name: 'transferWithAuthorization',
        type: 'function',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'signature', type: 'bytes' },
        ],
        outputs: [],
      },
    ],
    functionName: 'transferWithAuthorization',
    args: [
      args.from,
      args.to,
      args.value,
      args.validAfter,
      args.validBefore,
      args.nonce,
      args.signature,
    ],
  });
}
