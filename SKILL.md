---
name: xpay
description: >-
  Give an AI agent its own wallet and let it discover and pay for services.
  Use when the agent needs to find a paid API/service, pay for a call (x402 /
  USDC), send USDC to an address, check its balance, or review spending. Works
  from any agent framework (Claude, Codex, OpenAI, Gemini, custom) via MCP, CLI,
  or SDK.
---

# xPay — a wallet and payment rail for agents

xPay lets an agent **find a service, pay for it, and get the result** without
writing any payment plumbing. It hides x402, USDC, RPC, and multi-network
routing behind a flat set of tools.

The fastest mental model: `discover` (find a paid service) → `use` (pay + call
it) → you get the response. Or skip straight to `do` (find the best service for
an intent and call it in one step).

## Setup (zero-config)

Add xPay as an MCP server — no keys, no init:

```jsonc
{ "mcpServers": { "xpay": { "command": "npx", "args": ["-y", "@xona-labs/xpay", "mcp"] } } }
```

On first run the agent is given its **own wallet**. Its Solana address is
printed to the server's stderr — **fund that address with USDC** and the agent
can pay. The wallet persists and is reused across restarts.

To use a wallet you already hold instead, set `XPAY_SOLANA_SECRET` (base58) in
the MCP `env`. To require an explicit wallet (no auto-generation), set
`XPAY_NO_AUTO_WALLET=1`.

## Tools

| Tool | Use it to |
|---|---|
| `xpay_discover` | Find paid services by natural-language query. Returns ranked candidates with price, network, and payee. |
| `xpay_use` | Pay for and call a specific service. Pass the full `resource` object from `xpay_discover` (preferred), or a `resourceUrl`. Handles the x402 402-challenge → pay → retry flow. |
| `xpay_do` | One step: discover the best service for an intent **and** call it. Use when you don't need to compare options. |
| `xpay_transfer` | Send USDC (or any Solana SPL token) directly to an address. In the MCP server this returns a confirmation code; you must then call `xpay_transfer_confirm` — never auto-confirm without the user's approval. |
| `xpay_balance` | The wallet's balance per network, plus its addresses (use this to tell the user where to send funds). |
| `xpay_report` | Spending/income report (daily / weekly / monthly). |
| `xpay_guardrail` | Read the active spending caps (per-tx, per-day, allowed hosts, approval threshold). |
| `xpay_bento_status` | Check whether the Bento intent firewall is on (read-only). |
| `xpay_bento_enable` | Turn the Bento intent firewall on. Returns the agent wallet address to register at app.bentoguard.xyz. |
| `xpay_bento_disable` | Turn the Bento firewall off — use if the wallet isn't registered and payments are rejected. |

## How payment works

Services price calls in **USDC** over the **x402** protocol (typically fractions
of a cent to a few cents per call). `xpay_use` / `xpay_do` settle the payment
and call the service in one round-trip — the agent just receives the result. A
small platform fee ($0.01 USDC) applies per paid call.

The agent pays from its own wallet, so **it must be funded first**. If a call
fails for lack of funds, ask the user to send USDC to the address from
`xpay_balance` (Solana mainnet or Base).

## Safety — built in, respect it

- **Spending guardrail.** Per-tx and per-day USD caps and an allowed-host list
  are enforced *before* signing. A blocked call throws; don't try to route
  around it — surface the limit to the user.
- **Transfers need confirmation.** `xpay_transfer` only *stages* a transfer; it
  returns a code. Show the user the amount + destination and only call
  `xpay_transfer_confirm` after they approve. Never move funds unprompted.
- **Bento intent firewall (optional).** When enabled, every payment is screened
  for malicious intent (prompt-injection, wallet-drain) before signing. A
  `BLOCKED` result means stop. Toggle with `xpay_bento_enable` /
  `xpay_bento_disable`; it requires a one-time wallet registration at
  app.bentoguard.xyz, and until then payments are rejected — disable it to fall
  back to local caps if you don't want to register.

## Recipes

**Find and pay for a service**
1. `xpay_discover { query: "image alt-text generation" }`
2. Pick a candidate, then `xpay_use { resource: <that object>, body: { ... } }`
3. Use the returned `data`.

**One-shot**
- `xpay_do { query: "translate this text to Japanese", body: { text } }`

**Receive funds**
- `xpay_balance` → give the user the Solana address to send USDC to.

**Send funds (with approval)**
1. `xpay_transfer { amount: 5, to: "<address>", token: "USDC" }` → returns a code
2. Confirm details with the user
3. `xpay_transfer_confirm { confirmationCode: "<code>" }`

## CLI / SDK

The same capabilities exist as a CLI (`xpay discover|pay|transfer|balance|…`)
and a TypeScript SDK (`createXPay({ profile })` → `xpay.discover/use/do/transfer`).
The tool names mirror the CLI so the mental model is identical across all three.
See the [README](README.md) for CLI and SDK details.
