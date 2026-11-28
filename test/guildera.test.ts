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
      { run_id: "r1", status: "completed", results: [{ author: "a" }], count: 1 },
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
