# synthex-mcp-server

An MCP (Model Context Protocol) server for the **Synthex Forge x402** service catalogue.

Every paid route on the remote service at
[`https://x402.synthexforge.com`](https://x402.synthexforge.com) is exposed as
an MCP tool. Calling a paid tool proxies the request to the remote route, pays
for it with the [x402](https://x402.org) protocol (USDC on Base mainnet,
EIP-3009 `transferWithAuthorization`), and returns the result together with the
**on-chain settlement transaction hash**.

## What this package is — and is not

**This is the client-side MCP implementation of a remote paid service.**

The server logic, the pricing, the data, the signatures and the settlement all
live in the hosted Synthex Forge service. This repository contains **no**
service-side handlers, no seeds, no internal logic. It is a transport: it maps
MCP tool calls onto HTTP calls to the remote service and handles the x402
payment handshake in between.

The tool list is **generated** from the remote service's live OpenAPI document
(`https://x402.synthexforge.com/openapi.json`) and committed to the repository,
so the package works offline and installs in one command.

## Install

```bash
npx synthex-mcp-server
```

That is the whole install. The binary starts in **stdio** mode, which is what
Claude Desktop, Cursor, Cline and most MCP clients spawn.

For a hosted listing or a remote client, use the **streamable HTTP** transport:

```bash
npx synthex-mcp-server --http --port 8080
```

The MCP endpoint is then `http://<host>:8080/mcp`.

### Claude Desktop / Cursor config

```json
{
  "mcpServers": {
    "synthex": {
      "command": "npx",
      "args": ["-y", "synthex-mcp-server"]
    }
  }
}
```

## The tools

- **128 paid tools** — one per paid route on the remote service. Each tool
  carries the route's `summary` as its description, a JSON Schema derived from
  the route's request body, and the price, method, path and rail in its
  `_meta` block.
- **1 free tool** — `catalogue`. It reads the live public catalogue
  (`GET /.well-known/x402.json`) with no payment, so you can verify the server
  works without spending anything.

There is exactly one free tool by design: a paid route is a product surface,
and this package must not become a way around it.

## Payment model

Paid routes use the x402 v2 flow:

1. The server calls the remote route without payment.
2. The remote service answers `HTTP 402` with a base64 `PAYMENT-REQUIRED`
   header describing the requirement (scheme, network, asset, amount, payTo).
3. This server signs an EIP-3009 `transferWithAuthorization` over the USDC
   contract on Base mainnet and retries the request with the signed payload in
   the `PAYMENT-SIGNATURE` header.
4. The remote service settles and answers `HTTP 200` with a `PAYMENT-RESPONSE`
   header carrying the settlement transaction hash.

The result returned to the MCP client includes `settlement_tx` — the real
on-chain transaction hash. It is verifiable independently on Base.

### If no payer key is configured

A paid call returns an `isError` result carrying the exact payment
requirements and a one-line instruction. **It is never silently stubbed into a
fake success.** You can then either configure a key or call the route directly
with your own payment.

### Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYNTHX_PAYER_PRIVATE_KEY` | for paid calls | EIP-3009 payer key. Read from the environment only — never logged, never written to disk, never included in a payload. |
| `SYNTHX_ALLOW_LIVE_SPEND` | no | Set to `1` to permit a real on-chain payment. **Off by default.** With a key set but this flag off, paid calls return `live_spend_disabled`. |
| `SYNTHX_BASE_URL` | no | Override the remote service base URL. |
| `SYNTHX_TIMEOUT_MS` | no | Per-request timeout in milliseconds (default `30000`). |

Without `SYNTHX_PAYER_PRIVATE_KEY`, the free `catalogue` tool and `tools/list`
still work — you can inspect the whole catalogue and its prices for free.

## Inspecting the catalogue

```bash
npx synthex-mcp-server --list-tools
```

Prints the generated manifest: every tool with its remote route and price.

## Regenerating the tool list

The manifest is committed at `src/generated/tools.manifest.json`. To refresh it
against the live service:

```bash
npm run generate        # fetch the live OpenAPI document and rewrite the manifest
npm run generate:check  # verify the committed manifest still matches the live spec
```

`generate:check` exits non-zero when the committed tool set drifts from the
live paid-route set — it compares the route sets, not just the counts, so a
swapped or renamed route is caught.

## Development

```bash
npm ci
npm test        # 46 tests: payment flow, manifest integrity, secret-leak guard
npm run lint
npm run typecheck
npm run build
```

The test suite proves the real x402 flow — 402 challenge, EIP-3009 signing,
retry with the payment header, settlement receipt — against a **local fixture
server** that speaks the real protocol. **No real USDC is spent in tests**, and
live spend is gated behind `SYNTHX_ALLOW_LIVE_SPEND=1`, which is off by
default.

## Docker

```bash
docker build -t synthex-mcp-server .
docker run --rm -p 8080:8080   -e SYNTHX_PAYER_PRIVATE_KEY=0x...   -e SYNTHX_ALLOW_LIVE_SPEND=1   synthex-mcp-server --http --port 8080
```

## Security notes

- The payer key is read from the environment only. It is never logged, never
  written to disk, and never appears in a payment payload (the payload carries
  the payer's **public** address and a signature).
- A test scans the whole repository for key-shaped literals and fails if one is
  committed.
- `SYNTHX_ALLOW_LIVE_SPEND` gates real on-chain payment and defaults to off.

## License

MIT — see [LICENSE](./LICENSE).

## Links

- Remote service: https://x402.synthexforge.com
- Live catalogue: https://x402.synthexforge.com/.well-known/x402.json
- OpenAPI document: https://x402.synthexforge.com/openapi.json
- x402 protocol: https://x402.org
