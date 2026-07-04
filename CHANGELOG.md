# Changelog

All notable changes to `@xona-labs/xpay` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.5] – 2026-07-04

### Fixed
- **AgenC hires failed on mainnet with program error 102
  (`InstructionDidNotDeserialize`).** The deployed mainnet program requires a
  `moderator` argument in the hire instruction (P1.2 moderation gate) that
  SDK 0.7.1 predates. Bumped `@tetsuo-ai/marketplace-sdk` to `^0.8.0` and
  made the hire path resolve the listing's on-chain moderation record
  (`["listing_moderation", listing, specHash]` PDA — derivable without
  knowing the moderator; the record itself names the moderator), passing
  `moderator` + the explicit `listingModeration` account. Verified against
  mainnet by transaction simulation (executes cleanly end-to-end) and against
  the SDK's bundled program via the litesvm sandbox example.
- Hiring a listing with no on-chain moderation attestation now fails fast
  with a clear message instead of an opaque on-chain error (the gate is
  fail-closed).

## [0.2.4] – 2026-07-03

Re-release of 0.2.3 with no code changes (registry hygiene).

## [0.2.3] – 2026-07-03

### Added
- **AgenC marketplace (agenc.ag) as a discovery source with smart-routed
  execution.** Hireable AgenC listings now appear in `xpay discover` /
  `xpay_discover` alongside x402 services (marked `metadata.source: "agenc"`,
  priced in SOL). Discovery merges sources with failure isolation — one
  catalog going down no longer breaks discovery — and reserves result slots so
  marketplace listings aren't drowned out by the 21k-item x402 catalog. Opt
  out with `XPAY_DISCOVERY_SOURCES=orbitx402` or `discover({ sources })`.
- **Smart execution routing in `use()`.** AgenC resources are detected by
  their `agenc-hire` payment scheme and executed as on-chain SOL escrow hires
  via `@tetsuo-ai/marketplace-sdk` (humanless entry point — tasks pin to
  CreatorReview, so escrow never auto-releases without the buyer's
  acceptance). x402 resources keep the existing payment path; same
  `use()`/`do()` API for both. The result of a hire is a receipt
  (`task`, `hireRecord`, `txSig`, explorer link) — the provider works
  asynchronously.
- **CLI `xpay agenc hire <listingPda>` / `xpay agenc status <taskPda>`** and
  MCP tool `xpay_agenc_status` for tracking hire progress.
- **Guardrail SOL pricing.** AgenC hires are converted lamports → USD at spot
  (multi-feed: CoinGecko → Coinbase → Kraken, 60s cache) and enforced against
  the existing USD caps before signing; fails closed if no feed is reachable
  while caps are configured.
- Examples: `examples/agenc-hire.ts` (live discover → hire → poll) and
  `examples/agenc-local-sandbox.ts` (full hire lifecycle against the real
  compiled program in-process via litesvm — no RPC, no SOL spent).

### Changed
- `@solana/kit` bumped `^5.5.1` → `^6.9.0` (required by the AgenC SDK;
  `@x402/svm` accepts `>=5.1.0`).

## [0.2.2] – 2026-06-30

### Fixed
- **MCP transfers now execute on the first call instead of silently staging.**
  The MCP server previously overrode `xpay_transfer` to only *stage* a request
  and return a 6-digit code, requiring a second `xpay_transfer_confirm` call to
  actually move funds. Agents routinely skipped the follow-up call, read the
  `"Transfer staged…"` response as a receipt, and reported success with a
  **hallucinated transaction hash** — a hash that never hit the chain (not on
  Solscan, no funds moved). This affected private (MagicBlock PER) transfers in
  particular. The terminal path was never affected because it executes directly.
  `xpay_transfer` now runs the same direct path as the CLI, and
  `xpay_transfer_confirm` has been removed.

### Changed
- **The transfer spending gate no longer depends on the agent making a second
  tool call.** Safety comes from the guardrail (per-tx / per-day caps +
  `requireApprovalAbove`), which on MCP surfaces as a Touch ID prompt when
  biometric unlock is enabled — a gate the model cannot fake or skip. Set
  `xpay guardrail --require-approval-above 0` with biometric enabled to require
  approval on every transfer.

## [0.2.1] – 2026-06-24

### Docs
- **Documented the Bento intent firewall as an optional security layer.** README
  gains a "Security" section (enable / status / disable, no API key, one-time
  on-chain wallet registration, and the ALLOW / BLOCKED / ESCALATED verdicts),
  the MCP tool list re-includes `xpay_bento_status` / `xpay_bento_enable` /
  `xpay_bento_disable`, and SKILL.md re-adds the tools plus a safety note. No
  code change — the firewall shipped in 0.1.28; this release publishes the docs
  to npm.

## [0.2.0] – 2026-06-23

Milestone release consolidating the 0.1.24–0.1.31 line into four themes.

### Easiest onboarding
- **Zero-config wallet provisioning.** Drop the MCP server into any agent host
  with no env — the agent is given its own persistent wallet on first boot
  (address printed to stderr to fund). Bring-your-own-key and existing profiles
  still take precedence.
- **`SKILL.md`** — a framework-agnostic guide so any agent (Claude, Codex,
  OpenAI, Gemini, custom) can drive xPay's tools, kept current with this release.

### Smart pay routing
- **Balance-aware network selection.** When a service accepts multiple networks,
  `use` / `do` pay from the first network whose balance covers the cost (a $0
  Base wallet falls through to a funded Solana one). When none can cover it, the
  call fails fast with a clear per-network balance error instead of a raw 402.
- **Broader x402 compatibility.** The payment payload is sent under both
  `X-PAYMENT` and `Payment-Signature`, so providers that read the latter
  (e.g. Nansen) now settle.

### Spending guardrail
- Surfaced as a first-class feature: per-tx / per-day USD caps, allowed-host
  list, and an approval threshold, all enforced **before signing**. Two-step
  confirmation guards MCP transfers.

### Reporting
- Comprehensive on-chain USDC usage report (daily / weekly / monthly) via
  OrbitX402 — summary, timeline, top counterparties, and biggest transactions.

## [0.1.31] – 2026-06-23

### Fixed
- **Payments now work against x402 servers that expect a `Payment-Signature`
  header.** The retry attaches the payment payload under both `X-PAYMENT` (the
  common name) and `Payment-Signature` — some providers (e.g. Nansen) only read
  the latter and were silently returning `402 Payment Required` even though the
  payload was valid. Confirmed against the live Nansen endpoint: the same
  payload that was ignored under `X-PAYMENT` is accepted under
  `Payment-Signature` (reaching settlement). The payload is identical and
  servers ignore the header name they don't recognise, so existing endpoints
  are unaffected.

## [0.1.30] – 2026-06-23

### Fixed
- **`use` no longer attempts a payment on an unfunded network.** 0.1.29's
  balance-aware picker fell back to the "best-funded" option when none could
  cover the cost — which, with everything at $0, still tried to pay and surfaced
  a raw `402 Payment Required` from the provider. Now, when multiple networks
  are payable but none has the funds, `use` raises a clear error listing each
  network's USDC balance (e.g. *"insufficient USDC balance to pay on any funded
  network — base $0.00, solana $0.00"*) instead. The settlement flow itself is
  unchanged. A single-network resource is still attempted as before (funding is
  left to the payment flow).

## [0.1.29] – 2026-06-23

### Changed
- **`use` now picks the payment network by balance, not by list order.** When a
  resource accepts multiple networks (e.g. Base *and* Solana), xPay reads the
  wallet balance on each and pays from the first option that can cover the cost
  — so a $0 Base wallet automatically falls through to a funded Solana one.
  Previously it always took the first listed option (usually Base) and failed
  if that wallet was empty. Both the catalog and live-402 paths use the new
  picker. Single-network resources are unaffected (no extra balance lookups).
  Falls back to the best-funded option when none can cover the cost outright.

### Added
- **`Wallet.pickRequirementByBalance()`** — the async, balance-aware selector
  behind the above. `pickRequirement()` (first-match, sync) is retained.

### Added
- **Bento firewall controls exposed as MCP tools.** Agents can now manage the
  intent firewall directly, not just via the CLI:
  - `xpay_bento_status` — read whether screening is on (and the agent wallet to register).
  - `xpay_bento_enable` — turn it on; returns the agent wallet address to register at app.bentoguard.xyz.
  - `xpay_bento_disable` — turn it off; the escape hatch when the wallet isn't registered and payments are being rejected.
  Enable/disable take effect live on the running guardrail (no restart) and
  persist to the profile. Only available on profile-backed wallets — raw-key
  (`XPAY_SOLANA_SECRET`) mode reports `profileBacked: false`.
- **`Guardrail.bentoEnabled()` / `setBentoEnabled()`** for runtime toggling.

## [0.1.27] – 2026-06-23

### Added
- **`SKILL.md` — framework-agnostic onboarding guide.** A single page that
  teaches any agent (Claude, Codex, OpenAI, Gemini, custom) how to drive xPay:
  zero-config setup, the tool surface, the pay-per-call model, the safety rules
  (guardrail, transfer confirmation, Bento), and copy-paste recipes. Shipped in
  the npm package so hosts can read it from `node_modules/@xona-labs/xpay`.

### Changed
- **README MCP section leads with zero-config onboarding.** The primary example
  is now the no-env "agent gets its own wallet" config; bring-your-own-wallet
  (`XPAY_SOLANA_SECRET` / `XPAY_PASSPHRASE` / `XPAY_NO_AUTO_WALLET`) is shown as
  the override, matching the wallet-source precedence.

## [0.1.26] – 2026-06-23

### Added
- **Zero-config wallet onboarding for the MCP server.** Drop xPay into any
  agent host with no env at all — on first boot the agent is given its own
  persistent wallet (generated, saved under `~/.xpay`/`XPAY_HOME`, address
  printed to stderr to fund). Reused on every later boot, so the agent keeps a
  stable address. The wallet source order is: existing profile → raw key env
  (`XPAY_SOLANA_SECRET` / `XPAY_EVM_KEY`) → auto-provision. Bring-your-own-key
  always takes precedence; auto-provision is only the last resort.
  - Encrypts at rest when `XPAY_PASSPHRASE` is set, plaintext otherwise.
  - Opt out with `XPAY_NO_AUTO_WALLET=1` to restore the strict "no wallet"
    error.

### Changed
- **`mcp-server.ts` header now documents the zero-config form as primary.** The
  previous example showed `XPAY_PASSPHRASE` alone, which only works once a
  profile already exists — a setup trap for fresh hosts.

## [0.1.25] – 2026-06-23

### Fixed
- **Bento "agent not registered" detection.** Verified against the live Bento
  relayer: an unregistered agent wallet is rejected with `Agent not found` /
  `Agent security check failed`, not the `not registered` string the v0.1.24
  handler matched. The guardrail now detects the real message and surfaces the
  actionable fix (register the agent wallet in the Dashboard) instead of a raw
  relayer error.

### Changed
- **`xpay bento enable` spells out the owner-vs-agent wallet distinction.** The
  address to register is the *agent* wallet (the one the SDK signs with), which
  is usually different from the *owner* wallet used to log into the Dashboard.
  Registration is an on-chain tx paid by the owner wallet.

## [0.1.24] – 2026-06-23

### Added
- **Bento Guard intent firewall (optional).** A second enforcement gate on top
  of the local guardrail caps. When enabled, every `use` / `transfer` is
  screened by Bento's `protect()` for malicious *intent* — prompt-injection,
  wallet-drain, intent-vs-execution mismatch — before signing. The local
  guardrail still owns spend caps; Bento adds the AI intent layer xPay can't
  compute itself.
  - Enable per-profile with `xpay bento enable` (also `disable` / `status`).
  - No API key: Bento authenticates with the wallet's own key, which
    `createXPay` exposes to the SDK via `AGENT_WALLET_PRIVATE_KEY`.
  - One-time manual step: register the wallet address at
    [app.bentoguard.xyz](https://app.bentoguard.xyz/); `enable` prints it.
  - `BLOCKED` verdicts throw a `GuardrailError`; `ESCALATED` verdicts defer to
    the existing `onApprovalRequired` hook, or fail closed if none is set.
  - `@bentoguard/sdk` is an **optional** dependency loaded lazily — installs
    that can't build its native bindings won't break `npm i @xona-labs/xpay`,
    and the SDK is only required once a profile turns the firewall on.

## [0.1.20] – 2026-06-12

### Fixed
- **Catalog payments no longer fail with "feePayer is required in
  paymentRequirements.extra for SVM transactions".** Catalog entries are
  snapshots and don't carry the facilitator's per-challenge settlement
  fields. When the picked requirement is SVM v2 and `extra.feePayer` is
  missing, `use()` now falls back to the live 402 challenge flow (probe the
  URL, pay against the fresh requirements) instead of erroring.

## [0.1.19] – 2026-06-12

### Changed
- **Discovery searches server-side.** `discover({ query })` now passes the
  query to the OrbitX402 API (`?query=`), which searches and ranks the
  catalog and returns only the matches — one small request instead of
  downloading the entire 33k-item catalog (~2 minutes of sequential page
  fetches) to filter locally. Cold `xpay discover <query>` drops from
  minutes to ~2s. Local filtering remains as a fallback for endpoints that
  ignore the query param; no-query browsing still fetches the full catalog.

### Fixed
- **MCP server no longer unlocks the wallet just to read the Sana API key** —
  `config.json` is plaintext, so `sana_*` tools now register correctly when
  the server starts without `XPAY_PASSPHRASE` (e.g. biometric-unlock setups).

## [0.1.18] – 2026-06-12

### Fixed
- **`xpay balance` now unlocks via Touch ID** — it had its own inline
  passphrase prompt instead of the shared unlock path, so it never offered
  biometric unlock. It now uses `unlockActive` like every other command.

## [0.1.17] – 2026-06-12

### Added
- **Biometric unlock (macOS Touch ID)** — `xpay biometric enable|disable|status`.
  When enabled, the wallet passphrase is stored in the login keychain and
  released by a native LocalAuthentication helper (compiled on first use to
  `~/.xpay/bin/`, requires Xcode Command Line Tools) after a Touch ID check.
  The scrypt/AES wallet encryption is unchanged — the passphrase remains the
  fallback and recovery path. Unlock order is now: `--passphrase` flag →
  `$XPAY_PASSPHRASE` → Touch ID → interactive prompt.
- **Guardrail approval hook is now wired in the CLI and MCP server.**
  `requireApprovalAbove` previously always threw ("no onApprovalRequired hook
  configured"); `xpay pay` / `xpay transfer` now resolve it via Touch ID (when
  biometric unlock is enabled) or a y/n confirm on a TTY. The MCP server uses
  Touch ID only (no TTY) and denies above-threshold calls otherwise.
- **MCP server can start without `XPAY_PASSPHRASE`** — when the profile has
  biometric unlock enabled, the server prompts Touch ID once at startup
  instead of requiring the passphrase in plaintext host config.

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
