/**
 * `xpay x <user|posts> <handle>` — realtime X (Twitter) account data via
 * xona's x402-paywalled proxy (at-cost passthrough of X API pay-per-use
 * billing: ~$0.01 profile, ~$0.06 for 10 posts). Paid from the active
 * profile's wallet through the normal x402 flow, guardrail included.
 */

import chalk from "chalk";
import inquirer from "inquirer";
import { createXPay } from "../index.js";
import { unlockActive, guardrailWithApproval } from "./common.js";

const XDATA_BASE = process.env.XPAY_XDATA_ENDPOINT ?? "https://api.xona-agent.com";

export interface XCmdOptions {
  profile?: string;
  passphrase?: string;
  limit?: string;
  json?: boolean;
  yes?: boolean;
}

interface XUser {
  handle: string;
  name: string;
  bio: string;
  followers: number;
  following: number;
  postsCount: number;
  verified: boolean;
  verifiedType: string;
  createdAt: string | null;
  url: string;
}

interface XPost {
  text: string;
  createdAt: string | null;
  likes: number;
  reposts: number;
  replies: number;
  views?: number;
  url: string;
}

export async function runXUser(handle: string, opts: XCmdOptions): Promise<void> {
  const data = await paidFetch("/x/user", { handle }, "~$0.01", opts);
  const user = (data as { user: XUser }).user;

  if (opts.json) {
    process.stdout.write(JSON.stringify(user, null, 2) + "\n");
    return;
  }

  console.log("");
  console.log(`  ${chalk.bold(user.name)} ${chalk.dim("@" + user.handle)} ${user.verified ? chalk.blue("✓ " + user.verifiedType) : ""}`);
  if (user.bio) console.log(`  ${user.bio}`);
  console.log(
    chalk.dim(
      `  ${user.followers.toLocaleString()} followers · ${user.following.toLocaleString()} following · ${user.postsCount.toLocaleString()} posts` +
        (user.createdAt ? ` · since ${user.createdAt.slice(0, 10)}` : ""),
    ),
  );
  console.log(`  ${chalk.dim(user.url)}`);
}

export async function runXPosts(handle: string, opts: XCmdOptions): Promise<void> {
  const limit = opts.limit ? Number(opts.limit) : undefined;
  const data = await paidFetch("/x/posts", { handle, limit }, "~$0.06", opts);
  const posts = (data as { posts: XPost[] }).posts;

  if (opts.json) {
    process.stdout.write(JSON.stringify(posts, null, 2) + "\n");
    return;
  }

  if (posts.length === 0) {
    console.log(chalk.yellow(`No recent original posts from @${handle.replace(/^@/, "")}.`));
    return;
  }
  console.log("");
  for (const p of posts) {
    const when = p.createdAt ? p.createdAt.slice(0, 16).replace("T", " ") : "";
    console.log(`  ${chalk.dim(when)}  ${chalk.dim(`♥ ${p.likes}  ⇄ ${p.reposts}  💬 ${p.replies}${p.views !== undefined ? `  👁 ${p.views}` : ""}`)}`);
    console.log(`  ${p.text.replace(/\n/g, "\n  ")}`);
    console.log(`  ${chalk.dim(p.url)}`);
    console.log("");
  }
}

async function paidFetch(
  path: string,
  body: Record<string, unknown>,
  approxPrice: string,
  opts: XCmdOptions,
): Promise<unknown> {
  const profile = await unlockActive(opts);
  const xpay = createXPay({ profile, guardrail: guardrailWithApproval(profile) });

  if (process.stdin.isTTY && !opts.yes) {
    const { go } = await inquirer.prompt<{ go: boolean }>([
      {
        type: "confirm",
        name: "go",
        message: `Fetch realtime X data for ${chalk.cyan(String(body.handle))}? (${approxPrice} USDC, paid via x402)`,
        default: true,
      },
    ]);
    if (!go) {
      console.log(chalk.yellow("Cancelled."));
      process.exit(0);
    }
  }

  try {
    const result = await xpay.useByUrl(`${XDATA_BASE}${path}`, { method: "POST", body });
    return result.data;
  } catch (err) {
    console.error(chalk.red(`✗ ${(err as Error).message}`));
    process.exit(1);
  }
}
