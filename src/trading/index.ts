/**
 * Robinhood Chain token trading — direct Uniswap V3 (NOXA Fun launchpad).
 *
 * NOXA Fun tokens (fun.noxa.fi) launch straight into Uniswap V3 pools quoted
 * in WETH, so trading them is plain V3: quote via QuoterV2, execute via
 * SwapRouter02. No third-party API or key — everything is on-chain against the
 * chain's own RPC. GMGN was ruled out (no chain-4663 support, gated API).
 *
 * Scope v1: ETH ⇄ token only (buy with native ETH, sell back to native ETH).
 * The router auto-wraps ETH on buys; sells unwrap WETH → ETH via multicall.
 *
 * A trade is irreversible and risks wallet value, so — exactly like `swap` —
 * it runs through the guardrail *before* signing.
 */

import { Contract, Wallet, MaxUint256, getAddress, isAddress } from "ethers";
import type { Network } from "../types.js";
import type { Wallet as XPayWallet } from "../wallet/index.js";
import type { Guardrail } from "../guardrail/index.js";
import { tokenPriceUsd, resolveTokenBySymbol } from "./discovery.js";

export const ROBINHOOD_NETWORK = "robinhood";

/** Verified Robinhood Chain (chain 4663) contracts. */
export const RH_CONTRACTS = {
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  noxaLauncher: "0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB",
} as const;

/** Fee tiers probed (in bps*100) when the pool fee isn't known up front. NOXA uses 10000 (1%). */
const FEE_TIERS = [10000, 3000, 500, 100];

const DEFAULT_SLIPPAGE_BPS = 100; // 1% — memecoin pools with a 1% fee move fast.
const MAX_SLIPPAGE_BPS = 5000; // 50% hard ceiling.

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function multicall(bytes[] data) payable returns (bytes[])",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
];
// NOXA Fun token surface — non-standard getters a plain ERC-20 lacks.
const NOXA_TOKEN_ABI = [
  "function liquidityPool() view returns (address)",
  "function pairToken() view returns (address)",
  "function poolFee() view returns (uint24)",
  "function restrictionEndBlock() view returns (uint256)",
  "function maxWalletLimit() view returns (uint256)",
  "function maxTxLimit() view returns (uint256)",
];
// SwapRouter02 recipient constant: keep output in the router for a follow-up unwrap.
const ROUTER_ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const NATIVE_ETH = { symbol: "ETH", decimals: 18 } as const;

/** Trading settings — profile `config.trading`, overridable per call. */
export interface TradeConfig {
  /** Default max slippage in bps (100 = 1%). */
  slippageBps?: number;
}

export interface TradeArgs {
  /** Human amount of the input token (e.g. 0.01 ETH, or 1000 MEME). */
  amount: number;
  /** Input: "ETH" or an ERC-20 contract address / known trending symbol. */
  from: string;
  /** Output: "ETH" or an ERC-20 contract address / known trending symbol. */
  to: string;
  /** Only Robinhood Chain is supported today; defaults to "robinhood". */
  network?: Network;
  slippageBps?: number;
  wallet: XPayWallet;
  guardrail: Guardrail;
  config?: TradeConfig;
}

export interface TradeTokenInfo {
  symbol: string;
  /** Contract address, or "ETH" for the native gas token. */
  address: string;
  decimals: number;
}

export interface TradeRestriction {
  endBlock: number;
  currentBlock: number;
  maxWalletAtoms?: string;
  maxTxAtoms?: string;
}

export interface TradeQuote {
  network: "robinhood";
  from: TradeTokenInfo;
  to: TradeTokenInfo;
  /** Input in human / atomic units. */
  inAmount: number;
  inAtoms: string;
  /** Expected output before slippage, human / atomic. */
  outAmount: number;
  outAtoms: string;
  /** Min output after slippage (what the swap enforces on-chain), atomic. */
  minOutAtoms: string;
  /** Pool fee tier used (10000 = 1%). */
  poolFee: number;
  /** Uniswap V3 pool address the route goes through. */
  pool: string;
  slippageBps: number;
  /** Input-side USD estimate (GeckoTerminal spot). Best-effort. */
  usdValue?: number;
  /**
   * True when the counterparty token was NOT confirmed as a NOXA Fun launch —
   * it may still be tradeable, but treat the pool/price with more suspicion.
   */
  unverified: boolean;
  /** Present when the token is still inside its NOXA launch-restriction window. */
  restriction?: TradeRestriction;
}

export interface TradeResult extends TradeQuote {
  /** Transaction hash on Robinhood Chain. */
  txHash: string;
}

/** Quote a trade without executing — no guardrail, no signing, no funds moved. */
export async function tradeQuote(args: Omit<TradeArgs, "guardrail">): Promise<TradeQuote> {
  return (await prepare(args)).quote;
}

/** Execute a trade on Robinhood Chain. Guardrail runs before signing. */
export async function trade(args: TradeArgs): Promise<TradeResult> {
  const { quote, ethersWallet, side, token } = await prepare(args);

  // Guardrail *before* signing — same security boundary as swap/pay/transfer.
  // Reuse the "swap" scheme so host-whitelist is skipped and the USD estimate
  // is priced from `extra.usdEstimate` (see Guardrail.estimateUsd).
  await args.guardrail.check({
    resource: {
      resource: `xpay://trade/robinhood/${quote.from.symbol}-${quote.to.symbol}`,
      type: "swap",
      method: "POST",
      accepts: [
        {
          asset: quote.from.address,
          payTo: quote.to.address,
          amount: quote.inAtoms,
          scheme: "swap",
          network: "eip155:4663",
          extra: {
            usdEstimate: quote.usdValue,
            fromSymbol: quote.from.symbol,
            toSymbol: quote.to.symbol,
          },
        },
      ],
    },
    requirement: {
      asset: quote.from.address,
      payTo: quote.to.address,
      amount: quote.inAtoms,
      scheme: "swap",
      network: "eip155:4663",
      extra: { usdEstimate: quote.usdValue },
    },
  });

  const router = new Contract(RH_CONTRACTS.swapRouter02, ROUTER_ABI, ethersWallet);
  const inAtoms = BigInt(quote.inAtoms);
  const minOut = BigInt(quote.minOutAtoms);

  let txHash: string;
  if (side === "buy") {
    // ETH → token: router auto-wraps the ETH we send as `value`.
    const params = {
      tokenIn: RH_CONTRACTS.weth,
      tokenOut: token.address,
      fee: quote.poolFee,
      recipient: ethersWallet.address,
      amountIn: inAtoms,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    };
    const tx = await router.exactInputSingle!(params, { value: inAtoms });
    const receipt = await tx.wait(1);
    txHash = receipt?.hash ?? tx.hash;
  } else {
    // token → ETH: ensure allowance, then swap-to-router + unwrap in one tx.
    await ensureAllowance(ethersWallet, token.address, RH_CONTRACTS.swapRouter02, inAtoms);
    const iface = router.interface;
    const swapData = iface.encodeFunctionData("exactInputSingle", [
      {
        tokenIn: token.address,
        tokenOut: RH_CONTRACTS.weth,
        fee: quote.poolFee,
        recipient: ROUTER_ADDRESS_THIS, // keep WETH in the router for the unwrap
        amountIn: inAtoms,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ]);
    const unwrapData = iface.encodeFunctionData("unwrapWETH9", [minOut, ethersWallet.address]);
    const tx = await router.multicall!([swapData, unwrapData]);
    const receipt = await tx.wait(1);
    txHash = receipt?.hash ?? tx.hash;
  }

  return { ...quote, txHash };
}

// ─── Internals ─────────────────────────────────────────────────────────────────

interface Prepared {
  quote: TradeQuote;
  ethersWallet: Wallet;
  side: "buy" | "sell";
  /** The non-ETH token in the pair (the thing being bought or sold). */
  token: TradeTokenInfo;
}

async function prepare(args: Omit<TradeArgs, "guardrail">): Promise<Prepared> {
  const network = args.network ?? ROBINHOOD_NETWORK;
  if (network !== ROBINHOOD_NETWORK) {
    throw new Error(`xpay.trade: only Robinhood Chain ("robinhood") is supported (got "${network}")`);
  }
  if (!args.wallet.has(ROBINHOOD_NETWORK)) {
    throw new Error('xpay.trade: no "robinhood" signer configured — add it to your profile networks');
  }
  if (!Number.isFinite(args.amount) || args.amount <= 0) {
    throw new Error("xpay.trade: amount must be a positive number");
  }

  const signer = args.wallet.signer(ROBINHOOD_NETWORK);
  const ethersWallet = signer.getEvmWallet?.() as Wallet | undefined;
  if (!ethersWallet) {
    throw new Error("xpay.trade: the robinhood signer does not expose an EVM wallet");
  }

  const fromIsEth = isEth(args.from);
  const toIsEth = isEth(args.to);
  if (fromIsEth === toIsEth) {
    throw new Error(
      'xpay.trade: exactly one side must be native ETH (v1 supports ETH→token buys and token→ETH sells)',
    );
  }
  const side: "buy" | "sell" = fromIsEth ? "buy" : "sell";

  // Resolve the non-ETH token (address or trending symbol) + its metadata.
  const tokenRef = fromIsEth ? args.to : args.from;
  const token = await resolveToken(ethersWallet, tokenRef);

  // Inspect NOXA-ness / pool fee / restrictions.
  const meta = await inspectToken(ethersWallet, token.address);
  const restriction = meta.restriction;

  const inDecimals = fromIsEth ? NATIVE_ETH.decimals : token.decimals;
  const outDecimals = toIsEth ? NATIVE_ETH.decimals : token.decimals;
  const inAtoms = toAtoms(args.amount, inDecimals);
  if (inAtoms === 0n) {
    throw new Error(`xpay.trade: ${args.amount} is below the token's smallest unit (${inDecimals} decimals)`);
  }

  const tokenIn = fromIsEth ? RH_CONTRACTS.weth : token.address;
  const tokenOut = toIsEth ? RH_CONTRACTS.weth : token.address;

  // Quote across candidate fee tiers (prefer the token's declared NOXA fee).
  const feeCandidates = meta.poolFee ? [meta.poolFee, ...FEE_TIERS.filter((f) => f !== meta.poolFee)] : FEE_TIERS;
  const { outAtoms, poolFee } = await quoteBestFee(ethersWallet, tokenIn, tokenOut, inAtoms, feeCandidates);

  const slippageBps = clampSlippage(args.slippageBps ?? args.config?.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  const minOutAtoms = (outAtoms * BigInt(10_000 - slippageBps)) / 10_000n;

  // NOXA transfer caps. They only bind BUYS (max tokens received per tx, and a
  // ceiling on the resulting wallet balance), so we only check the buy side.
  // A buy that would breach a cap is failed up front with a clear message
  // rather than reverting opaquely on-chain. The cap info is surfaced on the
  // quote only when this trade is actually within striking distance of a cap
  // (>25% of it) — established tokens leave a far-future endBlock set with wide
  // caps, so reporting it unconditionally would be misleading noise.
  let boundRestriction: TradeRestriction | undefined;
  if (restriction && side === "buy") {
    const maxTx = restriction.maxTxAtoms ? BigInt(restriction.maxTxAtoms) : undefined;
    const maxWallet = restriction.maxWalletAtoms ? BigInt(restriction.maxWalletAtoms) : undefined;
    if (maxTx !== undefined && outAtoms > maxTx) {
      throw new Error(
        `xpay.trade: this buy (${fromAtoms(outAtoms, outDecimals)} ${token.symbol}) exceeds the token's ` +
          `per-tx cap of ${fromAtoms(maxTx, token.decimals)}. Buy a smaller amount.`,
      );
    }
    let resultingBalance: bigint | undefined;
    if (maxWallet !== undefined) {
      const current = await tokenBalanceOf(ethersWallet, token.address);
      resultingBalance = current + outAtoms;
      if (resultingBalance > maxWallet) {
        throw new Error(
          `xpay.trade: this buy would push your ${token.symbol} balance past the token's ` +
            `max-wallet cap of ${fromAtoms(maxWallet, token.decimals)}. Buy less.`,
        );
      }
    }
    const nearTx = maxTx !== undefined && outAtoms * 4n > maxTx;
    const nearWallet = maxWallet !== undefined && resultingBalance !== undefined && resultingBalance * 4n > maxWallet;
    if (nearTx || nearWallet) boundRestriction = restriction;
  }

  // Input-side USD via GeckoTerminal spot (WETH price for buys, token for sells).
  const usdValue = await priceInputUsd(fromIsEth ? RH_CONTRACTS.weth : token.address, args.amount);

  const quote: TradeQuote = {
    network: "robinhood",
    from: fromIsEth ? { ...NATIVE_ETH, address: "ETH" } : token,
    to: toIsEth ? { ...NATIVE_ETH, address: "ETH" } : token,
    inAmount: args.amount,
    inAtoms: inAtoms.toString(),
    outAmount: fromAtoms(outAtoms, outDecimals),
    outAtoms: outAtoms.toString(),
    minOutAtoms: minOutAtoms.toString(),
    poolFee,
    pool: meta.pool ?? "",
    slippageBps,
    usdValue,
    unverified: !meta.isNoxa,
    restriction: boundRestriction,
  };

  return { quote, ethersWallet, side, token };
}

function isEth(ref: string): boolean {
  const r = ref.trim().toLowerCase();
  return r === "eth" || r === "native";
}

/** Resolve a token reference (address or trending symbol) to symbol/decimals. */
async function resolveToken(wallet: Wallet, ref: string): Promise<TradeTokenInfo> {
  let address = ref.trim();
  if (!isAddress(address)) {
    // Treat as a symbol — resolve via GeckoTerminal trending/new pools.
    const found = await resolveTokenBySymbol(address);
    address = found.address;
  }
  address = getAddress(address); // checksum
  const erc20 = new Contract(address, ERC20_ABI, wallet);
  const [decimals, symbol] = await Promise.all([
    erc20.decimals!().then((d: bigint) => Number(d)).catch(() => 18),
    erc20.symbol!().catch(() => address.slice(0, 6) + "…"),
  ]);
  return { address, symbol, decimals };
}

interface TokenMeta {
  isNoxa: boolean;
  pool?: string;
  poolFee?: number;
  restriction?: TradeRestriction;
}

/** Probe a token's NOXA Fun surface — pool, fee tier, launch restrictions. */
async function inspectToken(wallet: Wallet, address: string): Promise<TokenMeta> {
  const t = new Contract(address, NOXA_TOKEN_ABI, wallet);
  try {
    const [pool, pair, fee] = await Promise.all([
      t.liquidityPool!() as Promise<string>,
      t.pairToken!() as Promise<string>,
      t.poolFee!().then((f: bigint) => Number(f)),
    ]);
    // Confirm it's a WETH-paired NOXA launch.
    const isNoxa = pair.toLowerCase() === RH_CONTRACTS.weth.toLowerCase();
    const meta: TokenMeta = { isNoxa, pool, poolFee: fee };
    if (isNoxa) {
      const [endBlockRaw, currentBlock] = await Promise.all([
        t.restrictionEndBlock!().then((b: bigint) => Number(b)).catch(() => 0),
        wallet.provider!.getBlockNumber(),
      ]);
      if (endBlockRaw > currentBlock) {
        const [maxWallet, maxTx] = await Promise.all([
          t.maxWalletLimit!().then((v: bigint) => v.toString()).catch(() => undefined),
          t.maxTxLimit!().then((v: bigint) => v.toString()).catch(() => undefined),
        ]);
        meta.restriction = {
          endBlock: endBlockRaw,
          currentBlock,
          maxWalletAtoms: maxWallet,
          maxTxAtoms: maxTx,
        };
      }
    }
    return meta;
  } catch {
    // Not a NOXA token (getters reverted) — still tradeable if a V3 pool exists.
    return { isNoxa: false };
  }
}

/** Quote across fee tiers; return the first that yields output. */
async function quoteBestFee(
  wallet: Wallet,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fees: number[],
): Promise<{ outAtoms: bigint; poolFee: number }> {
  const quoter = new Contract(RH_CONTRACTS.quoterV2, QUOTER_ABI, wallet);
  let lastErr: unknown;
  for (const fee of fees) {
    try {
      // QuoterV2 quote fns are non-view (revert-to-return) — must use staticCall.
      const res = await quoter.quoteExactInputSingle!.staticCall({
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const out = res[0] as bigint;
      if (out > 0n) return { outAtoms: out, poolFee: fee };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `xpay.trade: no Uniswap V3 pool with liquidity found for this pair on Robinhood Chain ` +
      `(tried fee tiers ${fees.join(", ")}). ${lastErr instanceof Error ? lastErr.message : ""}`.trim(),
  );
}

/** Approve the router to spend `amount` of `token` if the allowance is short. */
async function ensureAllowance(wallet: Wallet, token: string, spender: string, amount: bigint): Promise<void> {
  const erc20 = new Contract(token, ERC20_ABI, wallet);
  const current = (await erc20.allowance!(wallet.address, spender)) as bigint;
  if (current >= amount) return;
  const tx = await erc20.approve!(spender, MaxUint256);
  await tx.wait(1);
}

async function tokenBalanceOf(wallet: Wallet, token: string): Promise<bigint> {
  try {
    const erc20 = new Contract(token, ERC20_ABI, wallet);
    return (await erc20.balanceOf!(wallet.address)) as bigint;
  } catch {
    return 0n;
  }
}

async function priceInputUsd(tokenAddress: string, amount: number): Promise<number | undefined> {
  const price = await tokenPriceUsd(tokenAddress);
  return price === undefined ? undefined : price * amount;
}

function toAtoms(amount: number, decimals: number): bigint {
  // Avoid float drift on high-decimals tokens: build the atomic string by hand.
  const [whole, frac = ""] = amount.toString().split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((whole ?? "0") + fracPadded);
}

function fromAtoms(atoms: bigint, decimals: number): number {
  const s = atoms.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals);
  return Number(`${whole}.${frac}`);
}

function clampSlippage(bps: number): number {
  if (!Number.isFinite(bps) || bps < 0) return DEFAULT_SLIPPAGE_BPS;
  return Math.min(Math.round(bps), MAX_SLIPPAGE_BPS);
}
