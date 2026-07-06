# @xona-labs/xpay

[![npm](https://img.shields.io/npm/v/@xona-labs/xpay)](https://www.npmjs.com/package/@xona-labs/xpay)
[![downloads](https://img.shields.io/npm/dm/@xona-labs/xpay)](https://www.npmjs.com/package/@xona-labs/xpay)
[![license](https://img.shields.io/npm/l/@xona-labs/xpay)](https://github.com/xona-labs/xpay/blob/main/LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

> **Agentic-commerce wallet.** Multi-network USDC wallet, x402 payments, AgenC marketplace hires, and discovery across 20,000+ services — as a CLI, an SDK, and an MCP server.

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
// SDK — same primitives, programmatic
import { loadProfile, createXPay } from "@xona-labs/xpay";
const xpay = createXPay({ profile: await loadProfile({ passphrase }) });
const result = await xpay.do("translate this PDF to Japanese", { body: { file } });
```

xPay is the **wallet** and **rail** layer for agentic commerce. It hides x402, USDC, RPC, and multi-network routing behind a flat surface so agent builders (Claude / Codex / OpenAI / Gemini / your own) can find and pay for services without writing payment plumbing.

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
# ⚠ RECOVERY PHRASE — write this down NOW. We cannot recover it for you.
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
| `xpay balance` | USDC balance per network for the active profile. |
| `xpay discover [query]` | Search 21k+ x402 services across chains — Solana, Base, **BNB Chain**, and other EVM networks — plus **AgenC marketplace** agent listings (cached on disk). `--network`, `--limit`, `--json`. |
| `xpay pay <url>` | Pay an x402 endpoint. Works on catalog URLs and any URL that returns 402. `--max-usd`, `--body`, `-y`. |
| `xpay agenc hire <listingPda>` | Hire an [AgenC marketplace](#agenc-marketplace-hire-on-chain-agents) listing — escrows its SOL price on-chain; the provider works asynchronously. `--max-usd`, `--review-window`, `-y`. |
| `xpay agenc status <taskPda>` | Check a hire's progress (read-only, no wallet). `--json`. |
| `xpay token find <query>` | Find a Solana token by ticker, name, or mint address (Jupiter) — price, mcap, liquidity, verification. Read-only. `--limit`, `--json`. |
| `xpay swap <amount> <from> <to>` | Swap tokens in your wallet via Jupiter (Solana only), subject to the guardrail. `--slippage-bps`, `-y`. |
| `xpay x user \| posts <handle>` | Realtime X (Twitter) account data — profile (~$0.01) or recent posts (~$0.06), paid via x402 at cost. No X account needed. |
| `xpay zauth reposcan <repoUrl>` | Repository security scan via partner [zauth](#zauth-repo-security-scans) — zauth score + provenance/vulnerability report (~$0.05 USDC via x402). `--json`, `-y`. |
| `xpay zauth status <sessionToken>` | Check a running zauth scan (free, read-only, no wallet). `--json`. |
| `xpay transfer <amount> USDC <to>` | Direct USDC transfer, subject to the guardrail. `--network`, `-y`. |
| `xpay report` | Comprehensive USDC activity report — totals, net flow, timeline, top counterparties, biggest txs. `--period daily\|weekly\|monthly`, `--network`, `--json`. |
| `xpay guardrail show \| set \| clear` | Inspect or edit spending caps and allowed hosts. |
| `xpay biometric status \| enable \| disable` | Touch ID unlock for the wallet passphrase (macOS). |
| `xpay sana link \| unlink \| status` | Link a Sana API key to activate the agent card (optional). |
| `xpay mcp` | Start the MCP server on stdio (for Claude Desktop / Cursor / Codex). |

All commands run from a single profile. Switch with `xpay accounts use <name>`.

## SDK

The CLI is a thin shell over the SDK — every command has a direct programmatic equivalent.

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
await xpay.report({ period: "weekly" });   // via OrbitX402 — no RPC calls from your code
await xpay.wallet.balance("solana");
```

### Agent runtimes

xPay ships tool definitions for the three major LLM SDKs. Same handlers, different schema shapes.

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

Drop xPay into any MCP host's config — **no code, no keys, no `xpay init`.** On
first boot the agent is given its own wallet automatically:

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
stderr on first run** — fund it with USDC and the agent can pay. It persists
under `~/.xpay` and is reused on every later boot, so the address is stable.

The host sees the core tools: `xpay_discover`, `xpay_use`, `xpay_do`, `xpay_transfer`, `xpay_balance`, `xpay_report`, `xpay_guardrail`, `xpay_token_find`, `xpay_swap`, `xpay_x_user`, `xpay_x_posts`, `xpay_zauth_reposcan`, `xpay_zauth_scan_status`, `xpay_agenc_status`, plus `xpay_bento_status` / `xpay_bento_enable` / `xpay_bento_disable` to manage the [intent firewall](#security--bento-intent-firewall-optional). If you've linked a Sana key (see below), eight additional `sana_*` tools are also registered automatically.

**Bring your own wallet instead** — the wallet source order is *existing profile → key env → auto-generate*, so any of these overrides the generated wallet:

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

Skip typing the passphrase on every command — unlock with Touch ID instead:

```bash
xpay biometric enable     # verifies your passphrase, then stores it Touch ID-gated
xpay balance              # → Touch ID prompt instead of a passphrase prompt
xpay biometric status     # availability + current state
xpay biometric disable    # removes the keychain entry
```

How it works: the wallet's scrypt + AES-256-GCM encryption is unchanged. `enable` places the
passphrase in your **login keychain**, and a small native helper (compiled on first use to
`~/.xpay/bin/`, requires the Xcode Command Line Tools) releases it only after a
LocalAuthentication check. Biometrics never replace the passphrase — they gate access to it.

The unlock order for every command is: `--passphrase` flag → `$XPAY_PASSPHRASE` → Touch ID →
interactive prompt. Your passphrase keeps working everywhere and remains the only recovery
path — if Touch ID is unavailable (or the stored copy goes stale after a re-encrypt), the CLI
falls back to asking for it.

> macOS asks once to allow keychain access for the helper — choose **"Always Allow"**. It will
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

- **`maxPerTx` / `maxPerDay`** — apply to every paid call *and* direct transfers.
- **`allowedHosts`** — apply only to x402 calls (transfers go to addresses, not hosts).
- **`maxPerTx` / `maxPerDay`** — apply to every paid call *and* direct transfers.
- **`allowedHosts`** — apply only to x402 calls (transfers go to addresses, not hosts).
- **`requireApprovalAbove`** — calls ≥ threshold need explicit approval. In the CLI this is a
  Touch ID prompt when [biometric unlock](#biometric-unlock-macos) is enabled, otherwise a y/n
  confirm; in the MCP server it is Touch ID only (no terminal), so an agent's large payment
  surfaces as a system dialog you physically approve. In the SDK, wire the
  `onApprovalRequired` hook to whatever you like — push notification, biometric, webhook.

## Security — Bento intent firewall (optional)

Spend caps stop an agent spending *too much* — they can't tell a legitimate payment from a
prompt-injected one. The optional [Bento](https://app.bentoguard.xyz/) layer adds an **AI intent
firewall**: every paid call and transfer is screened for malicious intent (prompt-injection,
wallet-drain, intent-vs-execution mismatch) *before signing*. It runs inside the guardrail, right
after the local caps pass.

```bash
xpay bento enable      # prints the agent wallet address to register
xpay bento status      # whether screening is active
xpay bento disable     # turn off — falls back to local caps only
```

There's **no API key** — Bento authenticates with the wallet's own key. The one manual step is a
**one-time, on-chain registration** of the agent wallet at
[app.bentoguard.xyz](https://app.bentoguard.xyz/) (log in with your owner wallet; until the agent
wallet is registered, payments are rejected with `Agent not found`).

Each screened call returns a verdict:

- **`ALLOW`** — cleared; xPay signs as normal.
- **`BLOCKED`** — flagged as a critical threat; xPay throws before signing, no funds move.
- **`ESCALATED`** — ambiguous; xPay defers to your `onApprovalRequired` hook, or fails closed.

Agents can manage it over MCP too: `xpay_bento_status`, `xpay_bento_enable`, `xpay_bento_disable`
(disable is the escape hatch when the wallet isn't registered yet).

## Sana agent wallet card (optional)

xPay supports an optional integration with [Sana](https://sana.bot) — an agent-native card that lets your AI spend at the point of sale, anywhere Visa is accepted.

Activating it adds a second wallet surface to xPay: your on-chain USDC (xpay) for agentic x402 payments, and a Sana card (fiat) for everything else. The two compose naturally — an agent can top up the card from the xPay wallet when the balance runs low.

### Activate

1. Sign up at [sana.bot](https://sana.bot) and generate an API key at `sana.bot/gateway/app/api-keys` (scope: `read:all` covers everything read-only; add `write:card` for deposits and swaps).
2. Link it to your xPay profile:

```bash
xpay sana link sana_live_...
xpay sana status          # confirm it's stored
```

3. Restart your MCP client — eight `sana_*` tools appear automatically alongside the standard `xpay_*` tools.

### Tools registered

| Tool | What it does |
|---|---|
| `sana_card` | Card metadata — type, status, last 4, expiry |
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

Or set `SANABOT_API_KEY` in the environment — the MCP server picks it up without any code change.

### Unlink

```bash
xpay sana unlink          # removes the key from the profile
```

The `sana_*` tools disappear from the MCP server on next restart.

## AgenC marketplace — hire on-chain agents

[AgenC](https://agenc.ag) is a Solana-mainnet marketplace where registered agents sell services with on-chain escrow. Its hireable listings appear in `xpay discover` alongside x402 services — but they **execute differently**, and xpay routes them automatically:

| | x402 service | AgenC listing |
|---|---|---|
| Priced in | USDC | native **SOL** |
| Payment | HTTP `X-Payment` header | on-chain **escrow** (program `HJsZ…w1xK`) |
| Result | immediate HTTP response | **hire receipt** — the provider works asynchronously |
| Settlement | instant | after your review window (default 24h) |

```bash
xpay discover "research"                   # AgenC listings show as “agenc escrow”, priced in ◎SOL
xpay agenc hire <listingPda>               # confirm → escrow SOL → get a task PDA
xpay agenc status <taskPda>                # poll: open → claimed → review → settled
```

The same smart routing works in the SDK and MCP — `xpay.use(resource)` / `xpay_use` detect the `agenc-hire` payment scheme and run the escrow flow, returning a receipt (`task`, `txSig`, explorer link) as `data`. Hires are made through AgenC's *humanless* entry point, which pins the task to **CreatorReview** — escrowed funds never auto-release without your acceptance.

Notes:
- The guardrail applies to hires too: SOL prices are converted to USD at spot (multi-feed, cached) and checked against `maxPerTx`/`maxPerDay` **before signing**. If no price feed is reachable and caps are set, the hire fails closed.
- The wallet needs **SOL** (escrow + fees), not just USDC.
- Reviewing/accepting results happens on [agenc.ag](https://agenc.ag) for now; `xpay agenc accept` is planned.
- Config (optional): `agenc: { rpcUrl, reviewWindowSecs, endpoint }` in the profile, or `XPAY_AGENC_ENDPOINT`. Opt out of the discovery source with `XPAY_DISCOVERY_SOURCES=orbitx402`.

## Token discovery & swap (Solana)

Find any Solana token by ticker or mint address and swap into it from your own wallet — keyless, via Jupiter's meta-aggregator:

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
- **The guardrail applies.** The input side is priced in USD (Jupiter's own estimate) and enforced against `maxPerTx` / `maxPerDay` **before signing** — fails closed if the token can't be priced while caps are set. Swaps stay inside your wallet (no external recipient), so `allowedHosts` doesn't apply.
- **Slippage** defaults to Jupiter's dynamic slippage; override per call (`--slippage-bps`) or per profile (`swap.slippageBps`).
- Keyless by default (~20 req/s shared bucket). Set `JUPITER_API_KEY` (or profile `swap.apiKey`) for higher limits; `XPAY_JUPITER_ENDPOINT` overrides the API base.
- This is the **native** swap in your own xpay wallet. The separate `xpay sana swap` swaps inside a Sana-hosted wallet and needs a Sana API key.

## Realtime X (Twitter) data

Agents can pull live X account data with zero setup — no X developer account, no API key. xpay pays xona's x402-gated proxy per call, which passes X's pay-per-use billing through **at cost** (no markup):

```bash
xpay x user jup_ag          # profile: followers, bio, verification   (~$0.01)
xpay x posts jup_ag         # 10 recent posts + engagement metrics    (~$0.06)
```

MCP: `xpay_x_user` / `xpay_x_posts` — the classic flow is token due diligence: `xpay_token_find` → check the project's X account → swap only if it holds up. Payments go through the normal x402 flow, so the guardrail caps apply. Endpoint override: `XPAY_XDATA_ENDPOINT`.

## zauth repo security scans

Scan any git repository for code provenance and vulnerabilities via [zauth](https://zauth.inc)'s x402-paywalled scanner (partner integration) — returns a zauth score (0–100) plus a markdown analysis. Only the scan kickoff is paid (~$0.05 USDC on Solana or Base) and the guardrail caps apply (if your profile restricts `allowedHosts`, add `api.zauth.inc`). Status checks are free and need no wallet:

```bash
xpay zauth reposcan https://github.com/owner/repo   # paid: starts the scan (or returns a cached report)
xpay zauth status <sessionToken>                    # free: poll a still-running scan
```

A scan either returns a cached report immediately or `{ status: "scanning", scanId, sessionToken }`; xpay polls the free status endpoint automatically and hands you the sessionToken if the scan outlives the wait window. Follow up with the **sessionToken** (the JWT, valid ~1 hour) — not the scanId.

MCP: `xpay_zauth_reposcan` (paid, polls up to ~90s) / `xpay_zauth_scan_status` (free follow-up). Endpoint override: `XPAY_ZAUTH_ENDPOINT`.

## Multi-network

`init` configures Solana and Base by default. Add or change via `~/.xpay/<name>/config.json`:

```json
{
  "version": 1,
  "networks": ["solana", "base", "arbitrum"],
  "defaultNetwork": "solana",
  "rpcs": {
    "solana": "https://your-helius-endpoint",
    "base":   "https://your-alchemy-endpoint"
  }
}
```

Public RPCs work for development but rate-limit hard. Production deployments should configure dedicated RPC endpoints.

## How it works

- **Keys** — One BIP-39 mnemonic per profile derives Solana (`m/44'/501'/0'/0'`, Phantom-compatible) and EVM (`m/44'/60'/0'/0/0`, MetaMask-compatible) keypairs. Encrypted at rest with scrypt + AES-256-GCM.
- **Discovery** — the catalog spans 21k+ x402 endpoints across multiple chains — **Solana, Base, BNB Chain, and other EVM networks** — plus AgenC marketplace listings, merged from independent sources (`Promise.allSettled`, so one source failing never kills discovery). The fetcher walks each API's pagination, validates every entry against a Zod schema, and persists to `~/.xpay/cache/` so repeat lookups skip the cold-fetch tax. (Filter with `--network` / `discover({ networks })`; pick sources with `discover({ sources })` or `XPAY_DISCOVERY_SOURCES`.)
- **Pay** — `use()` and `useByUrl()` both go: guardrail check → signer.pay(USDC) on the right network → `X-Payment` header → retry. The signer abstraction means the same code path works for Solana SPL transfers and EVM ERC-20 transfers. AgenC resources are detected by their `agenc-hire` payment scheme and routed to the on-chain escrow flow instead — same `use()` call, different rail.
- **Report** — Comprehensive USDC activity (daily / weekly / monthly) fetched from the OrbitX402 API. On-chain data is resolved server-side — no RPC calls from xpay, no rate-limiting, no RPC key required.

## Project status

**v0.2.12 (current):**
- ✅ CLI: init, accounts, balance, discover, pay, agenc, token, swap, x, zauth, transfer, report, guardrail, mcp
- ✅ SDK: full parity with CLI; tool exporters for Claude / OpenAI / Gemini
- ✅ MCP server on stdio with 17 tools (incl. the Bento intent firewall)
- ✅ Solana token discovery + native Jupiter swaps (`xpay token find`, `xpay swap`)
- ✅ Realtime X (Twitter) data at cost via x402 (`xpay x user|posts`)
- ✅ zauth repo security scans via x402 (`xpay zauth reposcan`)
- ✅ Solana + Base mainnet with disk caching
- ✅ Optional Sana agent card integration (`xpay sana link`) — 8 additional `sana_*` tools
- ✅ AgenC marketplace as a discovery source + smart-routed SOL escrow hires (`xpay agenc hire|status`)

**Planned:**
- `bridge` — USDC EVM ↔ SVM via CCTP (Circle's native burn/mint)
- `link / unlink` — opt-in cloud sync (audit log, dashboard)
- Pay catalog + xona-labs catalog as additional discovery sources
- `xpay agenc accept|rate` — review AgenC hire results without leaving the CLI

## License

MIT — see [LICENSE](./LICENSE).
