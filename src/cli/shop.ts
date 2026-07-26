/**
 * `xpay shop <search|quote>` — product discovery across Google Shopping,
 * Amazon, and eBay via xona's x402-paywalled /shop/search endpoint. The
 * search POST is paid from the active profile's wallet through the normal
 * x402 flow (guardrail included); the quote preflight is free and needs no
 * wallet. `search` always quotes first so the confirmation prompt shows the
 * exact price, and refuses to pay for queries the parser rejects as
 * non-product.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { createXPay } from "../index.js";
import { unlockActive, guardrailWithApproval } from "./common.js";
import { SHOP_BASE, fetchShopQuote, type ShopSearchParams, type ShopQuote } from "../shop/index.js";

export interface ShopCmdOptions {
  profile?: string;
  passphrase?: string;
  marketplaces?: string;
  priceMin?: string;
  priceMax?: string;
  condition?: string;
  sort?: string;
  limit?: string;
  json?: boolean;
  yes?: boolean;
}

interface ShopProduct {
  marketplace: string;
  title: string;
  url: string;
  price: { amount: number | null; currency: string };
  original_price?: number | null;
  discount_pct?: number | null;
  rating?: number | null;
  reviews_count?: number | null;
  seller?: string | null;
  condition?: string;
  shipping?: { free: boolean | null; cost: number | null; text: string | null };
}

function readParams(query: string, opts: ShopCmdOptions): ShopSearchParams {
  return {
    query,
    marketplaces: opts.marketplaces
      ? opts.marketplaces.split(",").map((m) => m.trim()).filter(Boolean)
      : undefined,
    price_min: opts.priceMin ? Number(opts.priceMin) : undefined,
    price_max: opts.priceMax ? Number(opts.priceMax) : undefined,
    condition: opts.condition,
    sort: opts.sort,
    limit: opts.limit ? Number(opts.limit) : undefined,
  };
}

export async function runShopQuote(query: string, opts: ShopCmdOptions): Promise<void> {
  let quote: ShopQuote;
  try {
    quote = await fetchShopQuote(readParams(query, opts));
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(quote, null, 2) + "\n");
    return;
  }
  renderQuote(quote);
}

export async function runShopSearch(query: string, opts: ShopCmdOptions): Promise<void> {
  const params = readParams(query, opts);

  // Free preflight: exact price for the confirm prompt, and a hard stop on
  // queries the parser would reject (the paid door charges regardless).
  let quote: ShopQuote | undefined;
  try {
    quote = await fetchShopQuote(params);
  } catch (err) {
    console.log(chalk.dim(`  (quote preflight unavailable: ${(err as Error).message})`));
  }

  if (quote && !quote.is_product_query) {
    console.log(chalk.yellow("This query does not look like a product search, so a paid search would return nothing."));
    console.log(chalk.yellow("Rephrase it to describe an item to buy or compare (not paying)."));
    process.exit(1);
  }

  const priceLabel = quote ? `$${quote.price_usd} USDC` : "~$0.02 USDC";
  const targets = quote?.would_search?.join(", ");

  const profile = await unlockActive(opts);
  const xpay = createXPay({ profile, guardrail: guardrailWithApproval(profile) });

  if (process.stdin.isTTY && !opts.yes) {
    const { go } = await inquirer.prompt<{ go: boolean }>([
      {
        type: "confirm",
        name: "go",
        message:
          `Search ${chalk.cyan(query)}${targets ? ` across ${targets}` : ""}? ` +
          `(${priceLabel}, paid via x402; guardrail caps apply)`,
        default: true,
      },
    ]);
    if (!go) {
      console.log(chalk.yellow("Cancelled."));
      process.exit(0);
    }
  }

  let data: unknown;
  try {
    const result = await xpay.useByUrl(`${SHOP_BASE}/shop/search`, {
      method: "POST",
      body: params,
    });
    data = result.data;
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }
  renderResults(data);
}

function renderQuote(quote: ShopQuote): void {
  console.log("");
  console.log(`  ${chalk.bold("Product query:")} ${quote.is_product_query ? chalk.green("yes") : chalk.red("no")}`);
  console.log(`  ${chalk.bold("Price:")} $${quote.price_usd} USDC`);
  if (Array.isArray(quote.would_search)) {
    console.log(`  ${chalk.bold("Would search:")} ${quote.would_search.join(", ")}`);
  }
  const intent = quote.intent as Record<string, unknown> | undefined;
  if (intent) {
    const bits: string[] = [];
    if (intent.search_terms) bits.push(`terms: ${intent.search_terms}`);
    if (intent.price_min != null) bits.push(`min $${intent.price_min}`);
    if (intent.price_max != null) bits.push(`max $${intent.price_max}`);
    if (intent.condition) bits.push(`condition: ${intent.condition}`);
    if (intent.sort && intent.sort !== "relevance") bits.push(`sort: ${intent.sort}`);
    if (bits.length) console.log(chalk.dim(`  Parsed as ${bits.join(" · ")}`));
  }
  if (!quote.is_product_query) {
    console.log(chalk.yellow("\n  A paid search for this query would return nothing. Rephrase it first."));
  }
}

function renderResults(data: unknown): void {
  const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const results = Array.isArray(obj.results) ? (obj.results as ShopProduct[]) : [];

  if (obj.reason === "not_a_product_query") {
    console.log(chalk.yellow(`\n  ${String(obj.message ?? "Not a product query.")}`));
    return;
  }
  if (results.length === 0) {
    console.log(chalk.yellow("\n  No results (after filters/dedupe)."));
    const warning = obj.warning;
    if (typeof warning === "string") console.log(chalk.yellow(`  ${warning}`));
    return;
  }

  console.log("");
  results.forEach((p, i) => {
    const amount = p.price?.amount;
    const price = amount != null ? `$${amount}${p.price.currency !== "USD" ? ` ${p.price.currency}` : ""}` : "?";
    const strike =
      p.original_price != null && p.discount_pct
        ? chalk.dim(` (was $${p.original_price}, -${p.discount_pct}%)`)
        : "";
    const rating =
      p.rating != null ? chalk.dim(` ★${p.rating}${p.reviews_count ? ` (${p.reviews_count})` : ""}`) : "";
    const cond = p.condition && p.condition !== "new" ? chalk.dim(` · ${p.condition}`) : "";
    console.log(`  ${chalk.dim(String(i + 1).padStart(2))}. ${chalk.bold(price)}${strike}  ${p.title}`);
    console.log(`      ${chalk.dim(p.marketplace)}${cond}${rating}${p.seller ? chalk.dim(` · ${p.seller}`) : ""}`);
    console.log(`      ${chalk.dim(p.url)}`);
  });

  const summary = obj.price_summary as { min?: number; max?: number; median?: number } | undefined;
  if (summary && summary.min != null) {
    console.log(chalk.dim(`\n  ${results.length} results · $${summary.min} to $${summary.max} · median $${summary.median}`));
  }
  if (obj.cached === true) console.log(chalk.dim("  (served from xona's cache)"));
  const payment = obj.payment as { transaction?: string } | undefined;
  if (payment?.transaction) console.log(chalk.dim(`  paid tx: ${payment.transaction}`));
}
