# Changelog

All notable changes to `@xona-labs/xpay` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.5] – 2026-05-26

### Added
- **`UseResult.txSig` is now populated on SVM v2 calls** — extracted from
  the facilitator's `PAYMENT-RESPONSE` (or `X-PAYMENT-RESPONSE`) header,
  which carries the canonical `SettleResponse` envelope (base64 JSON).
  Previously `useByUrl()` returned `txSig: undefined` for v2 because the
  facilitator (not the client) broadcasts the transaction.
- **`UseResult.settlement?: SettleEnvelope`** — full settle envelope from
  the facilitator when present: `{ transaction, payer?, network, amount?,
  success?, extensions?, extra? }`. Useful for reconciliation
  (payer address, actual settled amount in `upto`-style schemes, etc.).

### Verified
- Live against `api.xona-agent.com/audio/x-text-to-speech` — 200 OK,
  $0.01 USDC settled, real on-chain signature
  (`3puHTvEY…EpEHi`) returned in both `txSig` and `settlement.transaction`.

## [0.1.4] – 2026-05-26

### Fixed
- **`useByUrl()` against canonical x402 SVM v2 servers** — the SDK now signs
  but does **not** broadcast the USDC transfer, and sends the canonical
  `PaymentPayloadV2` envelope (`{ x402Version, accepted, payload: { transaction } }`)
  base64-encoded in the `X-Payment` header. The facilitator verifies + settles.
  Verified live against `api.xona-agent.com` (200 OK, $0.01 USDC settled, real
  upstream response returned).
- 0.1.3 was sending a v1-style `txSig`-only header after a client-side
  broadcast, which spec-compliant facilitators (incl. `api.xona-agent.com`)
  reject with `"Unsupported x402 payload"`.

### Added
- New `Signer.getKitSigner?()` (optional, additive) — returns a `@solana/kit`
  `TransactionSigner`. `rawSolanaSigner` implements it out of the box.
  Custom signers (KMS/MPC) implementing it gain canonical x402 v2 support
  for SVM endpoints; existing custom signers without it keep working via
  the legacy broadcast-then-`txSig` path for non-SVM networks.
- New module `src/x402/svm-payment.ts` — wraps `@x402/svm`'s
  `ExactSvmScheme.createPaymentPayload` and assembles the canonical
  `PaymentPayloadV2` envelope. Used by `useByUrl()` for any network matching
  `solana` / `solana:*` / `solana-*`.

### Dependencies
- `@x402/core`, `@x402/svm` — canonical x402 encoding (no spec drift).
- `@solana/kit` — pulled in transitively by `@x402/svm`; used to construct
  `TransactionSigner` instances from existing `@solana/web3.js` Keypairs via
  `createKeyPairSignerFromBytes`.

### Notes
- `txSig` in the returned `UseResult` is **undefined** for SVM v2 calls (the
  facilitator broadcasts; we never see the resulting signature client-side).
  Downstream reconciliation can still use the upstream response + your own
  correlationId in your DB.
- Direct `transfer()` is unchanged — still uses `signer.pay()` (broadcasts
  client-side, returns the real `txSig`), since there's no facilitator in
  the direct-transfer path.

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

[Unreleased]: https://github.com/xona-labs/xpay/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/xona-labs/xpay/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/xona-labs/xpay/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/xona-labs/xpay/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/xona-labs/xpay/compare/v0.1.0...v0.1.2
[0.1.0]: https://github.com/xona-labs/xpay/releases/tag/v0.1.0
