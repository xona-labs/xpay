# @xona-labs/xpay

> **Agentic-commerce wallet.** Multi-network USDC wallet, x402 payments, and discovery across 20,000+ services — as a CLI, an SDK, and an MCP server.

```bash
npm install -g @xona-labs/xpay
xpay init                                  # creates Solana + EVM keys, encrypted
xpay discover "research API"               # 21k catalog, ranked
xpay pay  https://api.example.com/x402     # x402 one-liner
xpay transfer 5 USDC 7G73PL...gC           # direct USDC transfer
xpay balance                               # unified across networks
xpay history                               # recent activity, on-chain
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
| `xpay history` | Recent on-chain USDC activity across all networks. `--network`, `--limit`, `--evm-window`. |
| `xpay guardrail show \| set \| clear` | Inspect or edit spending caps and allowed hosts. |
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
await xpay.history({ limit: 10 });
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

The host then sees seven tools: `xpay_discover`, `xpay_use`, `xpay_do`, `xpay_transfer`, `xpay_balance`, `xpay_history`, `xpay_guardrail`. The server reads the same `~/.xpay/<profile>/` you created with `xpay init`.

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
- **`requireApprovalAbove`** — calls ≥ threshold call your `onApprovalRequired` hook (SDK only — wire to a push notification, biometric prompt, or webhook).

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
- **History** — Solana via `getSignaturesForAddress` + `getParsedTransaction` on the USDC ATA. EVM via chunked `eth_getLogs` for ERC-20 `Transfer` events. No indexer required.

## Project status

**v0.1 (current):**
- ✅ CLI: init, accounts, balance, discover, pay, transfer, history, guardrail, mcp
- ✅ SDK: full parity with CLI; tool exporters for Claude / OpenAI / Gemini
- ✅ MCP server on stdio with 7 tools
- ✅ Solana + Base mainnet with disk caching

**v0.2 planned:**
- `bridge` — USDC EVM ↔ SVM via CCTP (Circle's native burn/mint)
- `link / unlink` — opt-in cloud sync (audit log, dashboard)
- Pay catalog + xona-labs catalog as additional discovery sources

## License

MIT — see [LICENSE](./LICENSE).
