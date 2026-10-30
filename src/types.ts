/**
 * Shared types for the Synthex Forge x402 MCP server.
 *
 * The paid surface is REMOTE (https://x402.synthexforge.com). This package is
 * the client-side MCP implementation of that remote surface: it proxies every
 * paid route over HTTP and settles payment with the x402 protocol.
 */

/** A JSON Schema object as emitted in the tool manifest. */
export type JsonSchema = Record<string, unknown>;

/** Price + rail metadata attached to every paid tool. */
export interface ToolPricing {
  /** Human price in the declared currency, e.g. "0.02". */
  readonly amountUsd: string;
  /** Currency code, always "USD" for the current catalogue. */
  readonly currency: string;
  /** Atomic amount in the asset's smallest unit, e.g. "20000". */
  readonly amountAtomic: string;
  /** Asset contract address (USDC on Base mainnet). */
  readonly asset: string;
  /** Asset ticker symbol. */
  readonly assetSymbol: string;
  /** CAIP-2 network id, e.g. "eip155:8453". */
  readonly network: string;
  /** Settlement address that receives the payment. */
  readonly payTo: string;
  /** x402 payment scheme, "exact" for the current catalogue. */
  readonly scheme: string;
  /** Rail identifier, e.g. "x402/base/usdc". */
  readonly rail: string;
}

/** Where a tool's arguments travel on the wire. */
export interface ToolEndpoint {
  /** HTTP method. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  /** Path on the remote service, always starting with "/". */
  readonly path: string;
  /** True when the request body is JSON, false for query-only GETs. */
  readonly hasBody: boolean;
  /** True when the body is multipart/form-data rather than JSON. */
  readonly multipart: boolean;
  /** Query parameter names for GET routes. */
  readonly queryParams: readonly string[];
  /** Header parameter names that the caller may supply. */
  readonly headerParams: readonly string[];
}

/** One generated MCP tool, derived 1:1 from a paid route. */
export interface ToolDefinition {
  /** Stable slug, e.g. "v1_x402_quote". */
  readonly name: string;
  /** Route summary from the OpenAPI document. */
  readonly description: string;
  /** JSON Schema for the tool arguments. */
  readonly inputSchema: JsonSchema;
  /** JSON Schema for the response, when the spec provides one. */
  readonly outputSchema?: JsonSchema;
  /** The remote route this tool proxies to. */
  readonly endpoint: ToolEndpoint;
  /** Price + rail metadata. */
  readonly pricing: ToolPricing;
  /** The originating OpenAPI operationId. */
  readonly operationId: string;
  /** The route path on the remote service. */
  readonly remotePath: string;
}

/** The committed, offline-capable tool manifest. */
export interface ToolManifest {
  /** ISO timestamp of generation. */
  readonly generatedAt: string;
  /** Source OpenAPI document URL. */
  readonly source: string;
  /** Source document version. */
  readonly sourceVersion: string;
  /** Number of paid tools in this manifest. */
  readonly paidToolCount: number;
  /** Number of free tools shipped separately (always 1: `catalogue`). */
  readonly freeToolCount: number;
  /** The paid tools. */
  readonly tools: readonly ToolDefinition[];
}

/** Header names used by the x402 protocol. */
export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';
/** v1 legacy header, still accepted by the remote service. */
export const X_PAYMENT_HEADER = 'X-PAYMENT';

/** The remote service that hosts the paid surface. */
export const DEFAULT_BASE_URL = 'https://x402.synthexforge.com';

/** EIP-712 domain for Base mainnet USDC (EIP-3009 transferWithAuthorization). */
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_DECIMALS = 6;
export const CHAIN_ID = 8453;
export const TOKEN_NAME = 'USD Coin';
export const TOKEN_VERSION = '2';

/** The single free tool this package ships. */
export const FREE_TOOL_NAME = 'catalogue';
