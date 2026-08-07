# Xona Wallet

> Ships as the npm package `@xona-labs/xpay`, the `xpay` CLI, and the `xpay_*` MCP tools. The package and command names are unchanged.

[![npm](https://img.shields.io/npm/v/@xona-labs/xpay)](https://www.npmjs.com/package/@xona-labs/xpay)
[![downloads](https://img.shields.io/npm/dm/@xona-labs/xpay)](https://www.npmjs.com/package/@xona-labs/xpay)
[![license](https://img.shields.io/npm/l/@xona-labs/xpay)](https://github.com/xona-labs/xpay/blob/main/LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.xona--labs%2Fxpay-6e56cf)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.xona-labs/xpay)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

> **Agentic-commerce wallet.** Multi-network USDC wallet, x402 payments, AgenC marketplace hires, and discovery across 20,000+ services - as a CLI, an SDK, and an MCP server.

```bash
npm install -g @xona-labs/xpay
xpay init                                  # creates Solana + EVM keys, encrypted
xpay discover "research API"               # 21k x402 catalog + AgenC agent listings, ranked
xpay pay  https://api.example.com/x402     # x402 one-liner
xpay agenc hire <listingPda>               # hire an on-chain agent (SOL escrow)
xpay token find BONK                       # find any Solana token by ticker or mint
xpay swap 0.5 SOL BONK                     # swap in your own wallet via Jupiter
xpay transfer 5 USDC 7G73PL...gC           # direct USDC transfer
xpay balance                               # unified across networks
xpay report                                # daily / weekly / monthly report via OrbitX402
```

```ts
// SDK - same primitives, programmatic
import { loadProfile, createXPay } from "@xona-labs/xpay";
const xpay = createXPay({ profile: await loadProfile({ passphrase }) });
const result = await xpay.do("translate this PDF to Japanese", { body: { file } });
```

Xona Wallet is the **wallet** and **rail** layer for agentic commerce. It hides x402, USDC, RPC, and multi-network routing behind a flat surface so agent builders (Claude / Codex / OpenAI / Gemini / your own) can find and pay for services without writing payment plumbing.

---

## Install

```bash
npm install -g @xona-labs/xpay      # CLI + MCP server, system-wide
npm install     @xona-labs/xpay      # programmatic SDK in a project
```

## Quickstart

```bash
xpay init
# ✔ Profile "default" created at /Users/you/.xpay/default
# Solana  7RB7frdxPc9vZtuyq6YfNoWTJcDZsE2AcXXV6qkpf5ph
# EVM     0xA5D93CDB2bD16b2d1d3d19D45dad3FaBb1023dfa
# ⚠ RECOVERY PHRASE - write this down NOW. We cannot recover it for you.
#   1. depend   2. guess    3. mercy    4. online
#   ... (24 words)
```

Fund the addresses with a few dollars of USDC on Solana mainnet, Base, or both. Then:

```bash
xpay balance
xpay discover "image generation"
xpay pay https://orbisapi.com/proxy/image-alt-text-generator-api-1c9472
```

## CLI commands

| Command | What it does |
|---|---|
| `xpay init [name]` | Create a profile (Solana + EVM keys from one BIP-39 seed). `--import` to restore from a phrase, `--no-encrypt` for dev wallets, `--workspace` to store locally. |
| `xpay accounts list \| show \| use` | List profiles, inspect one, or set the active profile. |
| `xpay balance` | Token balances per network for the active profile, plus a stablecoin total. Covers Solana, Base and other EVM chains, Robinhood Chain, and [Stable](#stable-chain). `--network`. |
| `xpay discover [query]` | Search 21k+ x402 services across chains (Solana, Base, **BNB Chain**, and other EVM networks), plus **AgenC marketplace** agent listings (cached on disk). `--network`, `--limit`, `--json`. |
| `xpay pay <url>` | Pay an x402 endpoint. Works on catalog URLs and any URL that returns 402. `--max-usd`, `--body`, `-y`. |
| `xpay agenc hire <listingPda>` | Hire an [AgenC marketplace](#agenc-marketplace-hire-on-chain-agents) listing - escrows its SOL price on-chain; the provider works asynchronously. `--max-usd`, `--review-window`, `-y`. |
| `xpay agenc status <taskPda>` | Check a hire's progress (read-only, no wallet). `--json`. |
| `xpay token find <query>` | Find a Solana token by ticker, name, or mint address (Jupiter) - price, mcap, liquidity, verification. Read-only. `--limit`, `--json`. |
| `xpay token rwa [query]` | List tradable [RWA tokens](#rwa-discovery-solana) on Solana: tokenized stocks/ETFs (xStocks, Ondo, Remora) + USDY. Read-only. `--category`, `--limit`, `--json`. |
| `xpay swap <amount> <from> <to>` | Swap tokens in your wallet via Jupiter (Solana only), subject to the guardrail. `--slippage-bps`, `-y`. |
| `xpay trade <amount> <from> <to>` | Trade tokens on [Robinhood Chain](#robinhood-chain-trading) via Uniswap V3 / NOXA Fun (ETH↔token), subject to the guardrail. `--slippage-bps`, `--quote-only`, `-y`. |
| `xpay trending` | List tokens trending on Robinhood Chain (read-only, no wallet). `--new`, `--limit`. |
| `xpay x user \| posts <handle>` | Realtime X (Twitter) account data - profile (~$0.01) or recent posts (~$0.06), paid via x402 at cost. No X account needed. |
| `xpay zauth reposcan <repoUrl>` | Repository security scan via partner [zauth](#zauth-repo-security-scans) - zauth score + provenance/vulnerability report (~$0.05 USDC via x402). `--json`, `-y`. |
| `xpay zauth status <sessionToken>` | Check a running zauth scan (free, read-only, no wallet). `--json`. |
| `xpay shop search "<query>"` | [Product discovery](#xona-shop-product-discovery) across Google Shopping, Amazon, and eBay from one query (~$0.02 USDC via x402, less for fewer marketplaces). `--marketplaces`, `--price-min/max`, `--condition`, `--sort`, `--json`, `-y`. |
| `xpay shop quote "<query>"` | Free preflight: exact search price + how the query parses (no wallet). `--json`. |
| `xpay transfer <amount> USDC <to>` | Direct stablecoin transfer (USDC, or USDT0 on [Stable](#stable-chain)), subject to the guardrail. `--network`, `-y`. |
| `xpay report` | Comprehensive USDC activity report - totals, net flow, timeline, top counterparties, biggest txs. `--period daily\|weekly\|monthly`, `--network`, `--json`. |
| `xpay guardrail show \| set \| clear` | Inspect or edit spending caps and allowed hosts. |
| `xpay biometric status \| enable \| disable` | Touch ID unlock for the wallet passphrase (macOS). |
| `xpay sana link \| unlink \| status` | Link a Sana API key to activate the agent card (optional). |
| `xpay mcp` | Start the MCP server on stdio (for Claude Desktop / Cursor / Codex). |

All commands run from a single profile. Switch with `xpay accounts use <name>`.

## SDK

The CLI is a thin shell over the SDK - every command has a direct programmatic equivalent.

```ts
import {
  createXPay,
  initProfile,
  loadProfile,
  setProfileGuardrail,
} from "@xona-labs/xpay";

// One-time setup
const created = await initProfile({
  name: "default",
  passphrase: process.env.XPAY_PASSPHRASE!,
});
console.log(created.addresses);   // { solana, evm }
console.log(created.mnemonic);    // back this up; not persisted in plaintext

// Configure spending caps
setProfileGuardrail("default", {
  maxPerTx: 0.5,
  maxPerDay: 5,
  allowedHosts: ["api.payai.network", "*.xona-agent.com"],
});

// Use
const profile = await loadProfile({ name: "default", passphrase: process.env.XPAY_PASSPHRASE });
const xpay    = createXPay({ profile });

await xpay.discover({ query: "weather" });
await xpay.useByUrl("https://...");
await xpay.do("translate this PDF to Japanese");
await xpay.transfer({ amount: 1, to: "7G73PL...", token: "USDC" });
await xpay.report({ period: "weekly" });   // via OrbitX402 - no RPC calls from your code
await xpay.wallet.balance("solana");
```

### Agent runtimes

Xona Wallet ships tool definitions for the three major LLM SDKs. Same handlers, different schema shapes.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { createXPay, forClaude, loadProfile } from "@xona-labs/xpay";

const xpay = createXPay({ profile: await loadProfile({ passphrase }) });
const { tools, handlers } = forClaude(xpay);

const response = await new Anthropic().messages.create({
  model: "claude-sonnet-4-5",
  tools,
  messages: [{ role: "user", content: "find a cheap weather API and call it" }],
});

for (const block of response.content) {
  if (block.type === "tool_use") {
    const result = await handlers[block.name]!(block.input as Record<string, unknown>);
    // ... feed result back to Claude
  }
}
```

`forOpenAI(xpay)` and `forGemini(xpay)` return the same handlers wrapped in vendor-specific schemas. See [`examples/claude-agent.ts`](./examples/claude-agent.ts) for the full tool-use loop.

## MCP server (Claude Desktop / Cursor / Codex)

Xona Wallet is listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.xona-labs/xpay)
as **`io.github.xona-labs/xpay`** - registry-aware hosts can discover and
install it by that name. For everything else, drop Xona Wallet into the host's
config - **no code, no keys, no `xpay init`.** On first boot the agent is
given its own wallet automatically:

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "xpay": {
      "command": "npx",
      "args": ["-y", "@xona-labs/xpay", "mcp"]
    }
  }
}
```

That's the whole setup. The generated wallet's **Solana address is printed to
stderr on first run** - fund it with USDC and the agent can pay. It persists
under `~/.xpay` and is reused on every later boot, so the address is stable.

The host sees the core tools: `xpay_discover`, `xpay_use`, `xpay_do`, `xpay_transfer`, `xpay_balance`, `xpay_report`, `xpay_guardrail`, `xpay_token_find`, `xpay_swap`, `xpay_trending_tokens`, `xpay_trade_quote`, `xpay_trade`, `xpay_x_user`, `xpay_x_posts`, `xpay_zauth_reposcan`, `xpay_zauth_scan_status`, `xpay_shop_search`, `xpay_shop_quote`, `xpay_shop_lens`, `xpay_shop_lens_quote`, `xpay_rwa_find`, `xpay_agenc_status`, plus `xpay_bento_status` / `xpay_bento_enable` / `xpay_bento_disable` to manage the [intent firewall](#security--bento-intent-firewall-optional). If you've linked a Sana key (see below), eight additional `sana_*` tools are also registered automatically.

**Bring your own wallet instead** - the wallet source order is *existing profile → key env → auto-generate*, so any of these overrides the generated wallet:

```jsonc
"env": {
  "XPAY_SOLANA_SECRET": "<base58 key>",  // use a wallet you already hold
  "XPAY_PASSPHRASE":    "<passphrase>",  // or unlock/encrypt a profile
  "XPAY_NO_AUTO_WALLET": "1"             // or disable auto-generation entirely
}
```

On macOS, with [biometric unlock](#biometric-unlock-macos) enabled on a profile, the server shows one Touch ID dialog at startup instead of keeping the passphrase in host config.

See **[SKILL.md](SKILL.md)** for a framework-agnostic guide to driving these tools from any agent.

## Profiles

Each profile is a directory under `~/.xpay/` with:

```
~/.xpay/
├── default/                       (or any name)
│   ├── wallet.json                BIP-39 seed, AES-256-GCM encrypted by default
│   └── config.json                networks, guardrail, RPC overrides, link
└── cache/                         disk cache of catalogs (auto-managed)
```

Override with `XPAY_HOME=/some/path` or `xpay init --workspace` for project-local profiles.

## Biometric unlock (macOS)

Skip typing the passphrase on every command - unlock with Touch ID instead:

```bash
xpay biometric enable     # verifies your passphrase, then stores it Touch ID-gated
xpay balance              # → Touch ID prompt instead of a passphrase prompt
xpay biometric status     # availability + current state
xpay biometric disable    # removes the keychain entry
```

How it works: the wallet's scrypt + AES-256-GCM encryption is unchanged. `enable` places the
passphrase in your **login keychain**, and a small native helper (compiled on first use to
`~/.xpay/bin/`, requires the Xcode Command Line Tools) releases it only after a
LocalAuthentication check. Biometrics never replace the passphrase - they gate access to it.

The unlock order for every command is: `--passphrase` flag → `$XPAY_PASSPHRASE` → Touch ID →
interactive prompt. Your passphrase keeps working everywhere and remains the only recovery
path - if Touch ID is unavailable (or the stored copy goes stale after a re-encrypt), the CLI
falls back to asking for it.

> macOS asks once to allow keychain access for the helper - choose **"Always Allow"**. It will
> ask again after package upgrades, since the helper is recompiled.

## Guardrail

The guardrail runs **before** any signer is touched, so a misbehaving agent (or compromised LLM) cannot bypass it.

```bash
xpay guardrail set \
  --max-per-tx 0.5 \
  --max-per-day 5 \
  --require-approval-above 1 \
  --allowed-hosts 'api.payai.network,*.xona-agent.com'
```

- **`maxPerTx` / `maxPerDay`**: apply to every paid call *and* direct transfers.
- **`allowedHosts`**: apply only to x402 calls (transfers go to addresses, not hosts).
- **`maxPerTx` / `maxPerDay`**: apply to every paid call *and* direct transfers.
- **`allowedHosts`**: apply only to x402 calls (transfers go to addresses, not hosts).
- **`requireApprovalAbove`**: calls ≥ threshold need explicit approval. In the CLI this is a
  Touch ID prompt when [biometric unlock](#biometric-unlock-macos) is enabled, otherwise a y/n
  confirm; in the MCP server it is Touch ID only (no terminal), so an agent's large payment
  surfaces as a system dialog you physically approve. In the SDK, wire the
  `onApprovalRequired` hook to whatever you like - push notification, biometric, webhook.

## Security - Bento intent firewall (optional)

Spend caps stop an agent spending *too much* - they can't tell a legitimate payment from a
prompt-injected one. The optional [Bento](https://app.bentoguard.xyz/) layer adds an **AI intent
firewall**: every paid call and transfer is screened for malicious intent (prompt-injection,
wallet-drain, intent-vs-execution mismatch) *before signing*. It runs inside the guardrail, right
after the local caps pass.

```bash
xpay bento enable      # prints the agent wallet address to register
xpay bento status      # whether screening is active
xpay bento disable     # turn off - falls back to local caps only
```

There's **no API key** - Bento authenticates with the wallet's own key. The one manual step is a
**one-time, on-chain registration** of the agent wallet at
[app.bentoguard.xyz](https://app.bentoguard.xyz/) (log in with your owner wallet; until the agent
wallet is registered, payments are rejected with `Agent not found`).

Each screened call returns a verdict:

- **`ALLOW`**: cleared; Xona Wallet signs as normal.
- **`BLOCKED`**: flagged as a critical threat; Xona Wallet throws before signing, no funds move.
- **`ESCALATED`**: ambiguous; Xona Wallet defers to your `onApprovalRequired` hook, or fails closed.

Agents can manage it over MCP too: `xpay_bento_status`, `xpay_bento_enable`, `xpay_bento_disable`
(disable is the escape hatch when the wallet isn't registered yet).

## Sana agent wallet card (optional)

Xona Wallet supports an optional integration with [Sana](https://sana.bot) - an agent-native card that lets your AI spend at the point of sale, anywhere Visa is accepted.

Activating it adds a second wallet surface to Xona Wallet: your on-chain USDC (xpay) for agentic x402 payments, and a Sana card (fiat) for everything else. The two compose naturally - an agent can top up the card from the Xona Wallet wallet when the balance runs low.

### Activate

1. Sign up at [sana.bot](https://sana.bot) and generate an API key at `sana.bot/gateway/app/api-keys` (scope: `read:all` covers everything read-only; add `write:card` for deposits and swaps).
2. Link it to your Xona Wallet profile:

```bash
xpay sana link sana_live_...
xpay sana status          # confirm it's stored
```

3. Restart your MCP client - eight `sana_*` tools appear automatically alongside the standard `xpay_*` tools.

### Tools registered

| Tool | What it does |
|---|---|
| `sana_card` | Card metadata - type, status, last 4, expiry |
| `sana_card_balance` | Available spending power on the card |
| `sana_card_deposit` | Top up the card with USDC from the Sana wallet |
| `sana_card_transactions` | Card spending history (paginated) |
| `sana_portfolio` | Sana wallet net worth + token holdings with 24h changes |
| `sana_price` | Live USD price and 24h change for any token |
| `sana_swap` | Swap tokens inside the Sana wallet |
| `sana_notifications` | Recent Sana wallet activity feed |

### SDK usage

Pass the API key to `forClaude` / `forOpenAI` / `forGemini` to include Sana tools in your agent loop:

```ts
import { createXPay, loadProfile, forClaude } from "@xona-labs/xpay";

const xpay = createXPay({ profile: await loadProfile({ passphrase }) });
const { tools, handlers } = forClaude(xpay, {
  sanaApiKey: process.env.SANABOT_API_KEY,
});
// tools now includes both xpay_* and sana_* entries
```

Or set `SANABOT_API_KEY` in the environment - the MCP server picks it up without any code change.

### Unlink

```bash
xpay sana unlink          # removes the key from the profile
```

The `sana_*` tools disappear from the MCP server on next restart.

## AgenC marketplace - hire on-chain agents

[AgenC](https://agenc.ag) is a Solana-mainnet marketplace where registered agents sell services with on-chain escrow. Its hireable listings appear in `xpay discover` alongside x402 services - but they **execute differently**, and xpay routes them automatically:

| | x402 service | AgenC listing |
|---|---|---|
| Priced in | USDC | native **SOL** |
| Payment | HTTP `X-Payment` header | on-chain **escrow** (program `HJsZ…w1xK`) |
| Result | immediate HTTP response | **hire receipt** - the provider works asynchronously |
| Settlement | instant | after your review window (default 24h) |

```bash
xpay discover "research"                   # AgenC listings show as “agenc escrow”, priced in ◎SOL
xpay agenc hire <listingPda>               # confirm → escrow SOL → get a task PDA
xpay agenc status <taskPda>                # poll: open → claimed → review → settled
```

The same smart routing works in the SDK and MCP - `xpay.use(resource)` / `xpay_use` detect the `agenc-hire` payment scheme and run the escrow flow, returning a receipt (`task`, `txSig`, explorer link) as `data`. Hires are made through AgenC's *humanless* entry point, which pins the task to **CreatorReview** - escrowed funds never auto-release without your acceptance.

Notes:
- Discovery reads AgenC's **hosted indexer** via their official SDK client, the integration path AgenC documents, and hires locate the on-chain moderation attestation across seed-scheme generations, so xpay keeps working across AgenC's frequent program upgrades. Listings not yet re-attested after an upgrade fail closed with a clear message *before* any payment.
- The guardrail applies to hires too: SOL prices are converted to USD at spot (multi-feed, cached) and checked against `maxPerTx`/`maxPerDay` **before signing**. If no price feed is reachable and caps are set, the hire fails closed.
- The wallet needs **SOL** (escrow + fees), not just USDC.
- Reviewing/accepting results happens on [agenc.ag](https://agenc.ag) for now; `xpay agenc accept` is planned.
- Config (optional): `agenc: { rpcUrl, reviewWindowSecs, endpoint }` in the profile, or `XPAY_AGENC_ENDPOINT`. Opt out of the discovery source with `XPAY_DISCOVERY_SOURCES=orbitx402`.

## Token discovery & swap (Solana)

Find any Solana token by ticker or mint address and swap into it from your own wallet - keyless, via Jupiter's meta-aggregator:

```bash
xpay token find BONK                  # price, mcap, liquidity, mint, ✓ verified / ⚠ unverified
xpay swap 0.5 SOL BONK                # quote → confirm → execute (guardrail-gated)
xpay swap 1000 BONK USDC --slippage-bps 50
```

```ts
const tokens = await xpay.findTokens("BONK");          // ranked verified-first
const quote  = await xpay.swapQuote({ amount: 0.5, from: "SOL", to: tokens[0].mint });
const result = await xpay.swap({ amount: 0.5, from: "SOL", to: tokens[0].mint });
```

Notes:
- **Verification matters.** Anyone can mint a token reusing a real ticker. Bare tickers only resolve to Jupiter-**verified** tokens; ambiguous tickers error with a candidate list, and unverified tokens must be named by their exact mint. `xpay token find` shows the flag.
- **The guardrail applies.** The input side is priced in USD (Jupiter's own estimate) and enforced against `maxPerTx` / `maxPerDay` **before signing** - fails closed if the token can't be priced while caps are set. Swaps stay inside your wallet (no external recipient), so `allowedHosts` doesn't apply.
- **Slippage** defaults to Jupiter's dynamic slippage; override per call (`--slippage-bps`) or per profile (`swap.slippageBps`).
- Keyless by default (~20 req/s shared bucket). Set `JUPITER_API_KEY` (or profile `swap.apiKey`) for higher limits; `XPAY_JUPITER_ENDPOINT` overrides the API base.
- This is the **native** swap in your own xpay wallet. The separate `xpay sana swap` swaps inside a Sana-hosted wallet and needs a Sana API key.

## RWA discovery (Solana)

List tradable real-world-asset tokens: RWA covers any tokenized off-chain asset, and what actually trades on Solana DEXes today is tokenized stocks/ETFs (Backed xStocks like `TSLAx`/`SPYx`, Ondo Global Markets like `TSLAon`/`GLDon`, Remora, Backpack Securities) plus the treasury-backed yieldcoin `USDY`. Free, read-only, no wallet:

```bash
xpay token rwa                        # full list, verified-first by liquidity
xpay token rwa tesla                  # matches TSLAx (Backed) and TSLAon (Ondo)
xpay token rwa --category treasuries  # USDY
xpay swap 10 USDC TSLAx               # swap into one (guardrail-gated)
```

```ts
const rwas = await xpay.findRwaTokens({ query: "nvidia" });   // NVDAx, NVDAon
```

Notes:
- Discovery sweeps Jupiter's search API and filters by Jupiter's own `rwa`/`stocks`/`xstocks` token tags (the tag endpoint itself doesn't accept these), so the list is Jupiter-verified and priced live. Results cache in-process for 5 minutes.
- Tokenized stocks track the underlying price but are **issuer IOUs** (tracker certificates), not brokerage shares: no voting rights, issuer risk applies.
- Permissioned funds on Solana (BlackRock BUIDL, Ondo OUSG) are excluded: they are KYC-gated, unverified on Jupiter, and have no DEX liquidity, so they can't be swapped into anyway.
- MCP: `xpay_rwa_find` (free). Everything returned is swappable from USDC via `xpay_swap` / `xpay swap`.

## Robinhood Chain trading

Trade the [NOXA Fun](https://fun.noxa.fi/robinhood) memecoin scene on **Robinhood Chain** (Robinhood's Arbitrum L2, chain `4663`) straight from your own wallet - no API key. NOXA Fun tokens launch into Uniswap V3 pools quoted in native ETH, so trading is plain on-chain V3: quote via QuoterV2, execute via SwapRouter02. Discovery (trending / new tokens, USD pricing) comes from GeckoTerminal's public API.

```bash
xpay trending                              # what's hot on Robinhood Chain (free, no wallet)
xpay trending --new                        # freshest launches (higher risk)
xpay trade 0.01 ETH 0x020bfc…18b4          # buy a token with native ETH → quote → confirm → execute
xpay trade 5000 0x020bfc…18b4 ETH          # sell it back to ETH
xpay trade 0.01 ETH CASHCAT --quote-only   # preview without trading (symbol resolved via trending)
```

```ts
const hot    = await xpay.trendingTokens({ limit: 10 });          // symbol, address, price, volume
const quote  = await xpay.tradeQuote({ amount: 0.01, from: "ETH", to: hot[0].address });
const result = await xpay.trade({ amount: 0.01, from: "ETH", to: hot[0].address }); // → { txHash, ... }
```

Notes:
- **Scope:** ETH ⇄ token only (buy with native ETH, sell back to ETH). Buys auto-wrap ETH; sells unwrap WETH → ETH in one transaction.
- **The guardrail applies.** The input side is priced in USD (GeckoTerminal spot) and enforced against `maxPerTx` / `maxPerDay` **before signing** - same boundary as `xpay swap`.
- **Verification.** A token confirmed as a NOXA Fun launch is marked verified; anything else is flagged `unverified` (memecoin tickers aren't unique - prefer passing the exact contract address). NOXA per-tx / max-wallet transfer caps are checked before signing: a buy that would breach one errors up front (instead of reverting on-chain), and the quote flags trades that come close.
- **Gas:** unlike x402 payments, trades are broadcast from your wallet, so it needs a little ETH on Robinhood Chain for gas. Bridge via [Across](https://across.to) or the Uniswap bridge. RPC override: profile `rpcs.robinhood`.
- **Slippage** defaults to 100 bps (1%); override per call (`--slippage-bps`) or per profile (`trading.slippageBps`).
- **Balances:** `xpay balance` lists your Robinhood Chain ETH plus every ERC-20 you hold (via the chain's Blockscout explorer), so tokens bought here show up automatically. Override the explorer with `XPAY_ROBINHOOD_EXPLORER`.
- This is distinct from `xpay swap` (Solana / Jupiter). GMGN was evaluated and skipped - it doesn't support Robinhood Chain.

## Realtime X (Twitter) data

Agents can pull live X account data with zero setup - no X developer account, no API key. xpay pays xona's x402-gated proxy per call, which passes X's pay-per-use billing through **at cost** (no markup):

```bash
xpay x user jup_ag          # profile: followers, bio, verification   (~$0.01)
xpay x posts jup_ag         # 10 recent posts + engagement metrics    (~$0.06)
```

MCP: `xpay_x_user` / `xpay_x_posts` - the classic flow is token due diligence: `xpay_token_find` → check the project's X account → swap only if it holds up. Payments go through the normal x402 flow, so the guardrail caps apply. Endpoint override: `XPAY_XDATA_ENDPOINT`.

## zauth repo security scans

Scan any git repository for code provenance and vulnerabilities via [zauth](https://zauth.inc)'s x402-paywalled scanner (partner integration) - returns a zauth score (0–100) plus a markdown analysis. Only the scan kickoff is paid (~$0.05 USDC on Solana or Base) and the guardrail caps apply (if your profile restricts `allowedHosts`, add `api.zauth.inc`). Status checks are free and need no wallet:

```bash
xpay zauth reposcan https://github.com/owner/repo   # paid: starts the scan (or returns a cached report)
xpay zauth status <sessionToken>                    # free: poll a still-running scan
```

A scan either returns a cached report immediately or `{ status: "scanning", scanId, sessionToken }`; xpay polls the free status endpoint automatically and hands you the sessionToken if the scan outlives the wait window. Follow up with the **sessionToken** (the JWT, valid ~1 hour) - not the scanId.

MCP: `xpay_zauth_reposcan` (paid, polls up to ~90s) / `xpay_zauth_scan_status` (free follow-up). Endpoint override: `XPAY_ZAUTH_ENDPOINT`.

## xona shop product discovery

Search products across Google Shopping, Amazon, and eBay from a single free-text query via xona's x402-paywalled `/shop/search` endpoint (partner integration). The query parser picks up price ranges, condition, and sort straight from natural language; results come back normalized, deduped, and ranked in one schema. Price scales with the marketplaces searched: ~$0.02 USDC for all three, less for a subset (floor $0.005). Paid through the normal x402 flow, so guardrail caps apply (if your profile restricts `allowedHosts`, `api.xona-agent.com` must be on the list):

```bash
xpay shop quote "used thinkpad x1 under $600"    # free: exact price + parsed intent, no wallet
xpay shop search "used thinkpad x1 under $600"   # paid: quotes first, confirms, then searches
xpay shop search "sony wh-1000xm5" --marketplaces amazon,ebay --sort price_asc
```

`shop search` runs the free quote automatically before asking for confirmation, and refuses to pay when the parser says the query is not a product search (a paid search for such a query charges but returns zero results).

MCP: `xpay_shop_search` (paid) / `xpay_shop_quote` (free preflight: agents should quote first when a query is ambiguous). MCP results are compacted for context (image/position/scoring fields dropped); `xpay shop search --json` keeps the full payload. Endpoint override: `XPAY_SHOP_ENDPOINT`.

### Shop lens: image-based discovery

The same partner also answers "what is this, and where do I buy it" from a photo. Give `/shop/lens` an image and Google Lens identifies the product and the retailers selling it, normalized into the same schema as `/shop/search`. Two modes: `identify` (default, ~$0.02 USDC) returns the visual matches plus a derived product name; `shop` (~$0.04 for all three marketplaces) additionally runs that name through Google Shopping, Amazon, and eBay for a price comparison.

The lens engine itself only accepts a publicly reachable http(s) URL (SerpAPI fetches the image; data URIs are rejected), so the MCP tool takes the image as exactly one of three inputs: `image_url` (used as-is), `image_path` (local file), or `image_base64` (raw or data URI). Local files and base64 are first uploaded, free, to xona's public image host (JPEG/PNG/GIF/WebP, type sniffed from magic bytes, 25MB cap) and the hosted URL is echoed back as `hosted_image_url` for reuse. This is what makes images from chat clients that upload attachments (Hermes and friends) work: bytes in, public URL bridged automatically.

MCP: `xpay_shop_lens` (paid) / `xpay_shop_lens_quote` (free preflight: validates an image URL is publicly reachable and reports the exact price, no wallet). Agents should quote first when passing `image_url`, since the paid door charges even when the URL turns out to be unusable; uploads need no preflight because the hosted URL is always reachable. If the response flags the image as not a product photo, a `mode=shop` retry will not help.

## Multi-network

`init` configures Solana and Base by default. Add or change via `~/.xpay/<name>/config.json`:

```json
{
  "version": 1,
  "networks": ["solana", "base", "arbitrum", "stable"],
  "defaultNetwork": "solana",
  "rpcs": {
    "solana": "https://your-helius-endpoint",
    "base":   "https://your-alchemy-endpoint",
    "stable": "https://rpc.stable.xyz"
  }
}
```

Public RPCs work for development but rate-limit hard. Production deployments should configure dedicated RPC endpoints.

### Stable chain

**Stable** (chain `988`, Tether/Bitfinex's payments L1) is supported as a first-class wallet network. It settles **USDT0** (the LayerZero OFT at `0x779Ded0c9e1022225f8E0630b35a9b54bE713736`, 6 decimals as an ERC-20), not USDC.

The same derived EVM key covers it, so a Stable signer is registered on **every** profile whether or not `stable` is in `networks`. You get it without re-running `xpay init`:

```bash
xpay balance                               # includes a stable row: USDT0 + native USDT gas
xpay balance --network stable
xpay discover "image generation" --network stable
xpay transfer 1.5 0xRecipient --network stable          # sends USDT0
```

Notes:

- **Payments are gasless.** x402 calls on Stable sign an EIP-3009 `transferWithAuthorization` and the facilitator broadcasts, so the wallet needs USDT0 only - no native gas. Direct `xpay transfer` *is* broadcast from your wallet, so that path needs a little native USDT for gas.
- **The EIP-712 domain is `USDT0` / `1`, not the USDC default.** xpay never hardcodes it: the domain is read from `extra` on the live 402 challenge, which is the only reliable source (`version()` and `eip712Domain()` both revert on this contract).
- **Two tokens share a name.** The native gas coin is USDT at 18 decimals; the ERC-20 that x402 settles is USDT0 at 6. `xpay balance` lists them separately.
- **Routing is automatic.** A 402 quoting `eip155:988` resolves to the Stable signer, and `use()` compares USDT0 balance against the price when several chains are offered.
- RPC override: profile `rpcs.stable` (default `https://rpc.stable.xyz`). Explorer: [stablescan.xyz](https://stablescan.xyz).

## How it works

- **Keys**: One BIP-39 mnemonic per profile derives Solana (`m/44'/501'/0'/0'`, Phantom-compatible) and EVM (`m/44'/60'/0'/0/0`, MetaMask-compatible) keypairs. Encrypted at rest with scrypt + AES-256-GCM.
- **Discovery**: the catalog spans 21k+ x402 endpoints across multiple chains (**Solana, Base, BNB Chain, and other EVM networks**) plus AgenC marketplace listings, merged from independent sources (`Promise.allSettled`, so one source failing never kills discovery). The fetcher walks each API's pagination, validates every entry against a Zod schema, and persists to `~/.xpay/cache/` so repeat lookups skip the cold-fetch tax. (Filter with `--network` / `discover({ networks })`; pick sources with `discover({ sources })` or `XPAY_DISCOVERY_SOURCES`.)
- **Pay**: `use()` and `useByUrl()` both go: guardrail check → signer.pay(USDC) on the right network → `X-Payment` header → retry. The signer abstraction means the same code path works for Solana SPL transfers and EVM ERC-20 transfers. AgenC resources are detected by their `agenc-hire` payment scheme and routed to the on-chain escrow flow instead - same `use()` call, different rail.
- **Report**: Comprehensive USDC activity (daily / weekly / monthly) fetched from the OrbitX402 API. On-chain data is resolved server-side - no RPC calls from xpay, no rate-limiting, no RPC key required.

## Project status

**v0.2.14 (current):**
- ✅ CLI: init, accounts, balance, discover, pay, agenc, token, swap, x, zauth, shop, transfer, report, guardrail, mcp
- ✅ SDK: full parity with CLI; tool exporters for Claude / OpenAI / Gemini
- ✅ MCP server on stdio with 23 tools (incl. the Bento intent firewall)
- ✅ Solana token discovery + native Jupiter swaps (`xpay token find`, `xpay swap`)
- ✅ Realtime X (Twitter) data at cost via x402 (`xpay x user|posts`)
- ✅ zauth repo security scans via x402 (`xpay zauth reposcan`)
- ✅ xona shop product discovery via x402 (`xpay shop search`), free quote preflight
- ✅ RWA discovery on Solana (`xpay token rwa`): tokenized stocks/ETFs + USDY, swappable via `xpay swap`
- ✅ Solana + Base mainnet with disk caching
- ✅ Optional Sana agent card integration (`xpay sana link`) - 8 additional `sana_*` tools
- ✅ AgenC marketplace as a discovery source + smart-routed SOL escrow hires (`xpay agenc hire|status`)

**Planned:**
- `bridge`, USDC EVM ↔ SVM via CCTP (Circle's native burn/mint)
- `link / unlink`, opt-in cloud sync (audit log, dashboard)
- Pay catalog + xona-labs catalog as additional discovery sources
- `xpay agenc accept|rate` - review AgenC hire results without leaving the CLI

## License

MIT - see [LICENSE](./LICENSE).
