/**
 * Tidy GuildEra scrape results before they reach the agent.
 *
 * GuildEra reads X's rendered page, so each post's `text` carries the card
 * chrome (display name, @handle, "·", relative time, "Show more", and the
 * reply/retweet/like/view counters), cashtags and mentions sit on their own
 * lines, promoted posts are mixed in, and some post ids end in a path like
 * "/analytics" or "/photo/1". This module drops the ads, strips the chrome,
 * fixes the ids and adds a link.
 */

export interface RawPost {
  post_id?: string;
  author_username?: string;
  author_name?: string;
  text?: string;
  created_at?: string;
  like_count?: number;
  retweet_count?: number;
  reply_count?: number;
  quote_count?: number;
  view_count?: number;
  bookmark_count?: number;
  media_urls?: string[];
  is_reply?: boolean;
  is_retweet?: boolean;
  [k: string]: unknown;
}

export interface CleanPost {
  id: string;
  url: string;
  author: string;
  author_name: string;
  text: string;
  /** X cut the text off ("Show more"); open `url` for the full post. */
  truncated: boolean;
  created_at?: string;
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  views: number;
  bookmarks: number;
  media_urls: string[];
  is_reply: boolean;
  is_retweet: boolean;
}

/** A counter line from the card footer: 299, 4.9K, 22M, 1,204. */
const COUNTER = /^[\d.,]+[KMB]?$/;
/** A cashtag, hashtag or mention X rendered as its own span/line. */
const SPLIT_ENTITY = / *(^|\n)([$#@][A-Za-z0-9_]+)\n(?=(.?))/g;

function joinEntity(_m: string, lead: string, tag: string, next: string): string {
  const before = lead === "" ? "" : " ";
  const after = /[\w"'“(]/.test(next) ? " " : "";
  return `${before}${tag}${after}`;
}

interface Parsed {
  text: string;
  name?: string;
  isAd: boolean;
  truncated: boolean;
}

export function parsePostText(raw: string, username?: string): Parsed {
  let lines = raw.split("\n");
  let name: string | undefined;
  let isAd = false;

  // Header: name line(s), then @handle, then "·" + time, or "Ad".
  const handle = username ? `@${username}`.toLowerCase() : undefined;
  const h = lines.slice(0, 4).findIndex((l) =>
    handle ? l.trim().toLowerCase() === handle : /^@\w+$/.test(l.trim()),
  );
  if (h >= 0) {
    name = lines.slice(0, h).join(" ").trim() || undefined;
    let i = h + 1;
    if (lines[i]?.trim() === "Ad") {
      isAd = true;
      i += 1;
    } else if (lines[i]?.trim() === "·") {
      i += 2; // "·" then the time ("23h", "Nov 27")
    }
    lines = lines.slice(i);
  }

  // Footer: up to four counters (X hides zeros), then "Show more".
  let counters = 0;
  while (lines.length && counters < 4 && COUNTER.test(lines[lines.length - 1].trim())) {
    lines.pop();
    counters += 1;
  }
  let truncated = false;
  if (lines.length && lines[lines.length - 1].trim() === "Show more") {
    lines.pop();
    truncated = true;
  }

  const text = lines
    .join("\n")
    .replace(SPLIT_ENTITY, joinEntity)
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, name, isAd, truncated };
}

export interface CleanResult {
  posts: CleanPost[];
  ads_removed: number;
}

export function cleanPosts(raw: RawPost[]): CleanResult {
  const posts: CleanPost[] = [];
  const seen = new Set<string>();
  let adsRemoved = 0;

  for (const p of raw) {
    const id = /^\d+/.exec(String(p.post_id ?? ""))?.[0];
    const author = p.author_username ?? "";
    const parsed = parsePostText(String(p.text ?? ""), author || undefined);
    if (parsed.isAd) {
      adsRemoved += 1;
      continue;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    posts.push({
      id,
      url: author ? `https://x.com/${author}/status/${id}` : `https://x.com/i/status/${id}`,
      author,
      author_name: parsed.name ?? p.author_name ?? author,
      text: parsed.text,
      truncated: parsed.truncated,
      created_at: p.created_at,
      likes: p.like_count ?? 0,
      retweets: p.retweet_count ?? 0,
      replies: p.reply_count ?? 0,
      quotes: p.quote_count ?? 0,
      views: p.view_count ?? 0,
      bookmarks: p.bookmark_count ?? 0,
      media_urls: p.media_urls ?? [],
      is_reply: p.is_reply ?? false,
      is_retweet: p.is_retweet ?? false,
    });
  }
  return { posts, ads_removed: adsRemoved };
}
