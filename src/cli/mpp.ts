/**
 * `xpay mpp find [query]` / `xpay mpp resources <service>` - discover MPP
 * services from the MPPScan registry (mppscan.com).
 *
 * Free but SIWX-gated: the wallet signs an identity proof (EIP-191), nothing
 * is paid. Needs an unlocked profile for the EVM key.
 */

import chalk from "chalk";
import { unlockActive } from "./common.js";
import { signersFromProfile } from "../profile/index.js";
import { createWallet, type Wallet } from "../wallet/index.js";
import {
  findMppServices,
  searchMppServices,
  mppServiceResources,
} from "../discover/mppscan.js";

function walletFromProfile(profile: Parameters<typeof signersFromProfile>[0]): Wallet {
  const signers = signersFromProfile(profile);
  return createWallet({ networks: Object.keys(signers), signers });
}

export interface MppFindCmdOptions {
  profile?: string;
  passphrase?: string;
  limit?: string;
  protocol?: string;
  registry?: boolean;
  json?: boolean;
}

export interface MppResourcesCmdOptions {
  profile?: string;
  passphrase?: string;
  json?: boolean;
}

export async function runMppFind(query: string | undefined, opts: MppFindCmdOptions): Promise<void> {
  if (opts.protocol && opts.protocol !== "mpp" && opts.protocol !== "x402") {
    console.error(chalk.red(`✗ --protocol must be "mpp" or "x402", got "${opts.protocol}"`));
    process.exit(1);
  }

  const profile = await unlockActive(opts);
  const wallet = walletFromProfile(profile);
  const t0 = Date.now();

  try {
    // Natural-language query -> semantic search; no query (or --registry) ->
    // registry listing ranked by usage.
    if (query && !opts.registry) {
      const hits = await searchMppServices({
        wallet,
        query,
        protocol: opts.protocol as "mpp" | "x402" | undefined,
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
        return;
      }
      if (hits.length === 0) {
        console.log(chalk.yellow(`No MPP services match "${query}" (${Date.now() - t0}ms)`));
        return;
      }
      console.log(chalk.bold(`\nMPP services for "${query}"`) + chalk.dim(` (${Date.now() - t0}ms)\n`));
      for (const h of hits) {
        console.log(`  ${chalk.cyan(h.title)}  ${chalk.dim(h.origin)}  [${h.protocols.join(", ")}]`);
        if (h.description) console.log(chalk.dim(`    ${h.description.slice(0, 120)}`));
      }
      console.log(chalk.dim(`\nEndpoints: xpay mpp resources <origin> - then pay with: xpay pay <url>`));
      return;
    }

    const services = await findMppServices({
      wallet,
      query,
      limit: opts.limit ? Number(opts.limit) : 10,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(services, null, 2) + "\n");
      return;
    }
    if (services.length === 0) {
      console.log(chalk.yellow(`No registered MPP services${query ? ` match "${query}"` : ""}`));
      return;
    }
    console.log(chalk.bold("\nMPP registry (by transactions)") + chalk.dim(` (${Date.now() - t0}ms)\n`));
    for (const s of services) {
      const vol = s.volumeUsd !== undefined ? ` $${s.volumeUsd.toLocaleString()}` : "";
      console.log(
        `  ${chalk.dim(String(s.rank ?? "").padStart(3))} ${chalk.cyan(s.name)}  ${chalk.dim(s.url ?? "")}` +
          chalk.dim(`  ${s.transactions ?? 0} tx${vol}`),
      );
    }
    console.log(chalk.dim(`\nEndpoints: xpay mpp resources <domain-or-id>`));
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
}

export async function runMppResources(service: string, opts: MppResourcesCmdOptions): Promise<void> {
  if (!service) {
    console.error(chalk.red("✗ usage: xpay mpp resources <service-id-or-domain>"));
    process.exit(1);
  }

  const profile = await unlockActive(opts);
  const wallet = walletFromProfile(profile);

  try {
    const { service: svc, resources } = await mppServiceResources({ wallet, service });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ service: svc, resources }, null, 2) + "\n");
      return;
    }
    console.log(chalk.bold(`\n${svc.name || service}`) + (svc.url ? chalk.dim(`  ${svc.url}`) : ""));
    if (resources.length === 0) {
      console.log(chalk.yellow("  no active endpoints registered"));
      return;
    }
    for (const r of resources) {
      const price = r.priceUsd !== undefined ? `$${r.priceUsd}${r.pricingMode === "dynamic" ? "+" : ""}` : "?";
      console.log(`  ${chalk.green(r.method.padEnd(4))} ${r.url}  ${chalk.yellow(price)}`);
      if (r.summary) console.log(chalk.dim(`       ${r.summary.slice(0, 110)}`));
    }
    console.log(chalk.dim(`\nPay with: xpay pay <url> (handles MPP and x402)`));
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
}
