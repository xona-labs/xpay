# @xona-labs/xpay

> **Agentic-commerce wallet.** Multi-network USDC wallet, x402 payments, and discovery across 20,000+ services — as a CLI, an SDK, and an MCP server.

```bash
npm install -g @xona-labs/xpay
xpay init                                  # creates Solana + EVM keys, encrypted
xpay discover "research API"               # 21k catalog, ranked
xpay pay  https://api.example.com/x402     # x402 one-liner
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
| `xpay discover [query]` | Search 21k+ x402 services across chains — Solana, Base, **BNB Chain**, and other EVM networks (cached on disk). `--network`, `--limit`, `--json`. |
| `xpay pay <url>` | Pay an x402 endpoint. Works on catalog URLs and any URL that returns 402. `--max-usd`, `--body`, `-y`. |
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

Drop xPay into any MCP host's config — no code changes on the agent side.

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "xpay": {
      "command": "npx",
      "args": ["-y", "@xona-labs/xpay", "mcp"],
      "env": {
        "XPAY_PASSPHRASE": "<your-passphrase>"
      }
    }
  }
}
```

The host sees seven core tools: `xpay_discover`, `xpay_use`, `xpay_do`, `xpay_transfer`, `xpay_balance`, `xpay_report`, `xpay_guardrail`. If you've linked a Sana key (see below), eight additional `sana_*` tools are also registered automatically. The server reads the same `~/.xpay/<profile>/` you created with `xpay init`.

On macOS you can omit `XPAY_PASSPHRASE` entirely: with [biometric unlock](#biometric-unlock-macos) enabled, the server shows one Touch ID dialog at startup instead of keeping the passphrase in plaintext host config.

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
- **`requireApprovalAbove`** — calls ≥ threshold need explicit approval. In the CLI this is a
  Touch ID prompt when [biometric unlock](#biometric-unlock-macos) is enabled, otherwise a y/n
  confirm; in the MCP server it is Touch ID only (no terminal), so an agent's large payment
  surfaces as a system dialog you physically approve. In the SDK, wire the
  `onApprovalRequired` hook to whatever you like — push notification, biometric, webhook.

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
- **Discovery** — the catalog spans 21k+ x402 endpoints across multiple chains — **Solana, Base, BNB Chain, and other EVM networks** — so `discover()` surfaces BNB Chain x402 resources alongside everything else. The fetcher walks the offset-pagination, validates each entry against a Zod schema, and persists to `~/.xpay/cache/` so repeat lookups skip the cold-fetch tax. (Filter with `--network` / `discover({ networks })`.)
- **Pay** — `use()` and `useByUrl()` both go: guardrail check → signer.pay(USDC) on the right network → `X-Payment` header → retry. The signer abstraction means the same code path works for Solana SPL transfers and EVM ERC-20 transfers.
- **Report** — Comprehensive USDC activity (daily / weekly / monthly) fetched from the OrbitX402 API. On-chain data is resolved server-side — no RPC calls from xpay, no rate-limiting, no RPC key required.

## Project status

**v0.1 (current):**
- ✅ CLI: init, accounts, balance, discover, pay, transfer, report, guardrail, mcp
- ✅ SDK: full parity with CLI; tool exporters for Claude / OpenAI / Gemini
- ✅ MCP server on stdio with 7 core tools
- ✅ Solana + Base mainnet with disk caching
- ✅ Optional Sana agent card integration (`xpay sana link`) — 8 additional `sana_*` tools

**v0.2 planned:**
- `bridge` — USDC EVM ↔ SVM via CCTP (Circle's native burn/mint)
- `link / unlink` — opt-in cloud sync (audit log, dashboard)
- Pay catalog + xona-labs catalog as additional discovery sources

## License

MIT — see [LICENSE](./LICENSE).
