/**
 * guildera_* tool definitions: X/Twitter post scraping via GuildEra.
 *
 * Free (demo) for now, so these register by default with no key. The
 * upstream flow is submit -> run_id -> poll; `guildera_x_scrape` hides that
 * by polling for up to `wait_seconds` itself, and hands back the run_id when
 * the job is still running so the agent can finish with
 * `guildera_x_scrape_status`.
 */

import type { ClaudeToolDef, ToolBundle } from "../tools/index.js";
import { GuilderaClient, type GuilderaCaller } from "./client.js";
import { cleanPosts, type RawPost } from "./clean.js";

/** Upstream runs take ~10-30s; GuildEra asks for 15-20s between polls. */
const POLL_INTERVAL_MS = 15_000;
const DEFAULT_WAIT_S = 60;
const MAX_WAIT_S = 120;

const SCRAPE_PARAMS = [
  "source_type", "target", "max_results", "filter_replies", "post_type", "sort_by",
  "start_date", "end_date", "min_likes", "min_retweets", "min_replies", "min_views",
  "media_only", "raw_query",
] as const;

export interface GuilderaToolOptions {
  /** GUILD KEY (gk_live_...). Not needed while GuildEra is free. */
  key?: string;
  /** Test hooks. */
  client?: GuilderaCaller;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

interface RunStatus {
  run_id?: string;
  status?: string;
  [k: string]: unknown;
}

const isDone = (s: RunStatus) => s.status === "completed" || s.status === "failed";

/** Swap raw `results` for cleaned posts (ads dropped, chrome stripped, links added). */
export function tidyRun(s: RunStatus): RunStatus {
  if (!s || !Array.isArray(s.results)) return s;
  const { posts, ads_removed } = cleanPosts(s.results as RawPost[]);
  const { results: _raw, created_at: _c, updated_at: _u, ...rest } = s;
  return { ...rest, count: posts.length, ads_removed, results: posts };
}

export function forGuildera(opts: GuilderaToolOptions = {}): ToolBundle<ClaudeToolDef> {
  const client = opts.client ?? new GuilderaClient(opts.key);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;

  const status = async (runId: string) =>
    tidyRun((await client.callTool("guildera_scrape_status", { run_id: runId })) as RunStatus);

  const tools: ClaudeToolDef[] = [
    {
      name: "guildera_x_scrape",
      description:
        "Search and scrape X (Twitter) posts with engagement metrics (likes, retweets, replies, views) via GuildEra. " +
        "Free, no payment from the wallet. Promoted posts are removed (ads_removed says how many); each post has a url. " +
        "Waits for the job to finish (up to wait_seconds) and returns the posts; " +
        "if it is still running, returns a run_id to check with guildera_x_scrape_status. " +
        "Mapping: '$TICKER' -> source_type cashtag; '#tag' -> hashtag; '@user' -> user; anything else -> keyword. " +
        "'Top N / best posts' -> max_results 100, min_likes 10, sort_by likes, then show the first N. " +
        "'posts' without the word 'replies' -> filter_replies posts. Never set min_likes 50+ unless asked. " +
        "On 0 results retry in order: min_likes 0, wider/no start_date, filter_replies all, keyword instead of cashtag/hashtag.",
      input_schema: {
        type: "object",
        properties: {
          source_type: { type: "string", enum: ["user", "hashtag", "cashtag", "keyword", "url"] },
          target: { type: "string", description: "Only the entity: @user, #tag, $TICKER, a keyword, or a tweet URL." },
          max_results: { type: "number", description: "Posts to collect, 1-250. Default 20." },
          filter_replies: { type: "string", enum: ["all", "posts", "replies", "no_replies"], description: "posts = originals + quotes, no replies." },
          post_type: { type: "string", enum: ["all", "original", "retweets", "quotes", "replies"] },
          sort_by: { type: "string", enum: ["relevance", "likes", "retweets", "replies", "quotes", "views", "date_asc", "date_desc"] },
          start_date: { type: "string", description: "YYYY-MM-DD or words like 'today', 'past 7 days', 'this week', 'past month'." },
          end_date: { type: "string", description: "YYYY-MM-DD." },
          min_likes: { type: "number" },
          min_retweets: { type: "number" },
          min_replies: { type: "number" },
          min_views: { type: "number" },
          media_only: { type: "boolean", description: "Only posts with an image or video." },
          raw_query: { type: "string", description: "Full X search query; overrides source_type/target." },
          wait_seconds: { type: "number", description: `How long to wait for results before returning the run_id. Default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}, 0 = return immediately.` },
        },
        required: ["source_type", "target"],
      },
    },
    {
      name: "guildera_x_scrape_status",
      description:
        "Check a GuildEra X scrape by run_id (from guildera_x_scrape). Status queued/running -> check again in 15-20s; " +
        "completed -> results; failed -> error. Free.",
      input_schema: {
        type: "object",
        properties: { run_id: { type: "string" } },
        required: ["run_id"],
      },
    },
  ];

  const handlers: ToolBundle<ClaudeToolDef>["handlers"] = {
    guildera_x_scrape: async (input) => {
      const args: Record<string, unknown> = {};
      for (const k of SCRAPE_PARAMS) if (input[k] !== undefined) args[k] = input[k];

      const submitted = (await client.callTool("guildera_scrape", args)) as RunStatus;
      const runId = submitted?.run_id;
      if (!runId) return submitted;

      const waitS = Math.min(Math.max(Number(input.wait_seconds ?? DEFAULT_WAIT_S) || 0, 0), MAX_WAIT_S);
      const deadline = Date.now() + waitS * 1000;
      let last: RunStatus = submitted;
      while (Date.now() + interval <= deadline) {
        await sleep(interval);
        last = await status(runId);
        if (isDone(last)) return last;
      }
      return {
        run_id: runId,
        status: last.status ?? "queued",
        note: "Still running. Call guildera_x_scrape_status with this run_id in 15-20 seconds.",
      };
    },

    guildera_x_scrape_status: (input) => status(input.run_id as string),
  };

  return { tools, handlers };
}
