# Changelog

All notable changes to `@xona-labs/xpay` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.3] – 2026-05-26

### Fixed
- **`useByUrl()` against x402-spec endpoints** — now resolves the CAIP form
  of Solana (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` and `solana:*` /
  `solana-*` variants) to the configured `solana` signer. Previously failed
  with "no matching signer" against any endpoint reporting network in CAIP.
- **`xpay pay` defaulted to GET** — most x402 service endpoints are POST, so
  the CLI returned 404 from the upstream. Added a `--method <m>` flag and
  documented it in the help text.
- **Blank error output on signing failures** — `xpay pay` and `xpay transfer`
  printed a bare `✗` when the underlying Solana / SPL error had an empty
  `.message`. Now falls back to `toString()` and surfaces optional `logs`.
- **402 challenges in response headers** were not parsed — only the body was
  checked. Now reads the requirements from either the body OR a header
  (`Payment-Required`, `X-Payment`, `X-Accept-Payment`, `WWW-Authenticate`,
  `X-402`, …), decoded as raw JSON, base64-JSON, URL-encoded JSON, or
  `<scheme> <payload>`.
- **x402-spec field names not recognized** — the parser now aliases
  `maxAmountRequired → amount`, `recipient → payTo`, `token` / `mint` →
  `asset`, etc. Also accepts a bare requirement object, an `{accepts:[]}` /
  `{items:[]}` envelope, or a v1 bare array.

### Changed
- npm `homepage` updated to `https://xpay.xona-agent.com`.
- README and CLI examples updated to reference `*.xona-agent.com`.

### Removed
- **`probe` is no longer part of the public API.** The function and CLI
  command were dropped from the documented surface (no `xpay probe`, no
  `XPay.probe` method, no MCP tool). The implementation files remain in the
  shipped `dist/` so internal pipelines (e.g. curation) can deep-import.

### Internal
- New shared `src/x402/extract.ts` module — single source of truth for
  parsing x402 challenges, consumed by both `useByUrl()` and the internal
  curation pipeline. Replaces the duplicated parser that used to live in
  `use/` and `probe/`.

## [0.1.2] – earlier

Last release before this changelog was introduced. See the git history /
GitHub releases page for the diff against 0.1.0.

## [0.1.0] – 2026-05-22

Initial public release.

### Added
- Multi-network wallet — Solana + Base from one BIP-39 mnemonic, encrypted
  on disk with scrypt + AES-256-GCM.
- `discover()` — search across the live x402 catalog (PayAI facilitator).
- `useByUrl()` / `use()` — pay any x402 endpoint, handles the 402
  challenge → sign → retry-with-`X-Payment` flow.
- `transfer()` — direct USDC send to an address, gated by the same guardrail.
- `balance()` — unified USDC balance across configured networks.
- `history()` — recent on-chain USDC activity (Solana via RPC, EVM via
  chunked `eth_getLogs`).
- `Guardrail` — per-tx and per-day caps + allowed-host whitelist, enforced
  before any signature.
- Profile management — `initProfile()`, `loadProfile()`, multi-profile via
  `~/.xpay/<name>/`.
- CLI: `xpay init / accounts / discover / pay / transfer / balance / history /
  guardrail / mcp`.
- MCP server (`xpay-mcp`) on stdio — exposes the SDK as tools for Claude
  Desktop, Cursor, Codex.
- LLM tool exporters: `forClaude(xpay)`, `forOpenAI(xpay)`, `forGemini(xpay)`.

[Unreleased]: https://github.com/xona-labs/xpay/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/xona-labs/xpay/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/xona-labs/xpay/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/xona-labs/xpay/releases/tag/v0.1.0
