import "./helpers.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { forGuildera } from "../src/guildera/tools.js";
import { TOOL_ANNOTATIONS, forClaude } from "../src/tools/index.js";
import type { XPay } from "../src/index.js";

function fakeClient(statuses: Record<string, unknown>[]) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    async callTool(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      if (name === "guildera_scrape") return { success: true, run_id: "r1", status: "queued" };
      return statuses.shift() ?? { run_id: "r1", status: "running" };
    },
  };
}

const noSleep = async () => {};

describe("guildera tools", () => {
  it("submits only known params and polls until completed", async () => {
    const client = fakeClient([
      { run_id: "r1", status: "running" },
      { run_id: "r1", status: "completed", results: [{ post_id: "1", author_username: "a", text: "A\n@a\n·\n1h\nhi" }], count: 1 },
    ]);
    const { handlers } = forGuildera({ client, sleep: noSleep, pollIntervalMs: 1 });
    const out = (await handlers.guildera_x_scrape({
      source_type: "cashtag", target: "$SOL", sort_by: "likes", wait_seconds: 5, bogus: 1,
    })) as { status: string; count: number };
    assert.equal(out.status, "completed");
    assert.equal(out.count, 1);
    assert.deepEqual(client.calls[0], {
      name: "guildera_scrape",
      args: { source_type: "cashtag", target: "$SOL", sort_by: "likes" },
    });
    assert.deepEqual(client.calls[1], { name: "guildera_scrape_status", args: { run_id: "r1" } });
  });

  it("returns the run_id when wait_seconds is 0", async () => {
    const client = fakeClient([]);
    const { handlers } = forGuildera({ client, sleep: noSleep });
    const out = (await handlers.guildera_x_scrape({ source_type: "keyword", target: "solana", wait_seconds: 0 })) as {
      run_id: string; status: string;
    };
    assert.equal(out.run_id, "r1");
    assert.equal(out.status, "queued");
    assert.equal(client.calls.length, 1);
  });

  it("is on by default in forClaude, annotated, and can be turned off", () => {
    const xpay = {} as XPay;
    const on = forClaude(xpay).tools.map((t) => t.name);
    assert.ok(on.includes("guildera_x_scrape"));
    assert.ok(on.includes("guildera_x_scrape_status"));
    assert.equal(TOOL_ANNOTATIONS.guildera_x_scrape.readOnlyHint, true);
    const off = forClaude(xpay, { guildera: false }).tools.map((t) => t.name);
    assert.ok(!off.some((n) => n.startsWith("guildera_")));
  });
});

import { cleanPosts, parsePostText } from "../src/guildera/clean.js";

// Real shapes from a GuildEra $SOL run (2026-11-28).
const NEWS = {
  post_id: "2126251286928736504",
  author_username: "WatcherGuru",
  author_name: "WatcherGuru",
  text: "Watcher Guru\n@WatcherGuru\n·\nNov 27\nJUST IN: Aon settles premiums on Solana \n$SOL\n.\n299\n563\n4.9K\n498K",
  like_count: 4917, retweet_count: 563, reply_count: 299, view_count: 498778,
};
const AD = {
  post_id: "2102535881760407573/analytics",
  author_username: "APompliano",
  text: "Anthony Pompliano \n@APompliano\nAd\nTap a ticker like \n$NVDA\n to trade.\nShow more\n46\n50\n717\n22M",
  like_count: 717,
};
const LONG = {
  post_id: "2126348202286961015/photo/1",
  author_username: "Trail2Crypto",
  text: "Trail2Crypto\n@Trail2Crypto\n·\n20h\n \n$SOL\n GREAT BUY ZONE\n\n\n@solana\n is testing $72.\nShow more\n14\n12\n89\n4.7K",
  like_count: 89,
};

describe("guildera result cleanup", () => {
  it("strips header, counters and rejoins split cashtags", () => {
    const p = parsePostText(NEWS.text, "WatcherGuru");
    assert.equal(p.text, "JUST IN: Aon settles premiums on Solana $SOL.");
    assert.equal(p.name, "Watcher Guru");
    assert.equal(p.isAd, false);
    assert.equal(p.truncated, false);
  });

  it("flags truncated posts and keeps paragraphs", () => {
    const p = parsePostText(LONG.text, "Trail2Crypto");
    assert.equal(p.text, "$SOL GREAT BUY ZONE\n\n@solana is testing $72.");
    assert.equal(p.truncated, true);
  });

  it("drops ads, fixes ids, adds links, dedupes", () => {
    const out = cleanPosts([NEWS, AD, LONG, { ...LONG }]);
    assert.equal(out.ads_removed, 1);
    assert.deepEqual(out.posts.map((p) => p.id), ["2126251286928736504", "2126348202286961015"]);
    assert.equal(out.posts[1].url, "https://x.com/Trail2Crypto/status/2126348202286961015");
    assert.equal(out.posts[0].likes, 4917);
  });

  it("cleans results returned by the status tool", async () => {
    const client = fakeClient([{ run_id: "r1", status: "completed", results: [NEWS, AD], count: 2 }]);
    const { handlers } = forGuildera({ client, sleep: noSleep });
    const out = (await handlers.guildera_x_scrape_status({ run_id: "r1" })) as {
      count: number; ads_removed: number; results: { url: string }[];
    };
    assert.equal(out.count, 1);
    assert.equal(out.ads_removed, 1);
    assert.equal(out.results[0].url, "https://x.com/WatcherGuru/status/2126251286928736504");
  });
});

describe("guildera entity joining", () => {
  it("joins a leading cashtag to the word after it", () => {
    assert.equal(parsePostText("D\n@d\n·\n1h\n$SOL\nforming a higher low", "d").text, "$SOL forming a higher low");
  });
});
