import "./helpers.js";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { json, mockFetch } from "./helpers.js";
import {
  MachineNotFoundError,
  findMachines,
  getMachine,
  machineSearchParams,
  machineStats,
  normalizeMachineId,
  summarizeMachineTrust,
  type Machine,
  type MachineDetail,
} from "../src/machines/index.js";
import { TOOL_ANNOTATIONS, forClaude } from "../src/tools/index.js";
import type { XPay } from "../src/index.js";

const OWNER = "0x1111111111111111111111111111111111111111";

function machine(over: Partial<Machine> = {}, credit: Partial<Machine["credit"]> = {}): Machine {
  return {
    id: "4242",
    did: "did:peaq:4242",
    chain: "peaq",
    type: "robot_arm",
    category: "robot",
    owner: OWNER,
    controller: "0x2222222222222222222222222222222222222222",
    registered_block: 100,
    registered_at: "2026-10-01T00:00:00Z",
    endpoints: [],
    manufacturer: "Acme",
    active: true,
    indexed: true,
    explorer_url: "https://peaq.subscan.io/account/0x11",
    credit: {
      rating: "NR",
      score: 0,
      bond_status: "bonded",
      negative_flag: false,
      event_count: 0,
      revenue_event_count: 0,
      activity_event_count: 0,
      revenue_usd: 0,
      revenue_trend: "flat",
      degraded: false,
      updated_at: "2026-11-20T00:00:00Z",
      ...credit,
    },
    ...over,
  };
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  delete process.env.XPAY_MACHINES_ENDPOINT;
});

describe("normalizeMachineId", () => {
  it("accepts digits and did:peaq:<digits>", () => {
    assert.equal(normalizeMachineId("4242"), "4242");
    assert.equal(normalizeMachineId("  did:peaq:4242 "), "did:peaq:4242");
    assert.equal(normalizeMachineId("DID:PEAQ:7"), "did:peaq:7");
    assert.equal(normalizeMachineId(99 as unknown as string), "99");
  });

  it("rejects anything else", () => {
    for (const bad of ["", "abc", "did:peaq:", "did:other:1", "12a", "../1", "1 2", "did:peaq:1/../2"]) {
      assert.throws(() => normalizeMachineId(bad), /machine id/, bad);
    }
    assert.throws(() => normalizeMachineId("1".repeat(81)), /longer than 80/);
    assert.throws(() => normalizeMachineId(undefined), /machine id/);
  });
});

describe("machineSearchParams", () => {
  it("maps filters to the backend query string", () => {
    const p = machineSearchParams({
      category: "robot",
      type: "robot_arm",
      active: false,
      owner: OWNER.toUpperCase().replace("0X", "0x"),
      query: " arm ",
      rated: true,
      sort: "revenue",
      limit: 5,
      offset: 10,
      includeTest: true,
    });
    assert.equal(
      p.toString(),
      `category=robot&type=robot_arm&active=false&owner=${OWNER}&q=arm&rated=true&sort=revenue&limit=5&offset=10&include_test=true`,
    );
  });

  it("validates inputs", () => {
    assert.throws(() => machineSearchParams({ owner: "0x123" }), /EVM address/);
    assert.throws(() => machineSearchParams({ category: "toaster" as never }), /unknown category/);
    assert.throws(() => machineSearchParams({ sort: "price" as never }), /sort must be/);
    assert.throws(() => machineSearchParams({ limit: 0 }), /limit/);
    assert.throws(() => machineSearchParams({ limit: 101 }), /limit/);
    assert.throws(() => machineSearchParams({ limit: 2.5 }), /limit/);
    assert.throws(() => machineSearchParams({ offset: -1 }), /offset/);
    assert.throws(() => machineSearchParams({ type: "a&b=c" }), /type must be/);
    assert.throws(() => machineSearchParams({ query: "x".repeat(201) }), /query/);
    assert.equal(machineSearchParams({}).toString(), "");
  });
});

describe("machines API client", () => {
  it("findMachines hits /api/machines on the default host and returns data", async () => {
    const data = { total: 1, items: [machine()], indexed_through_block: 999 };
    const m = mockFetch([(u) => (u.pathname === "/api/machines" ? json({ success: true, data }) : undefined)]);
    restore = m.restore;
    const out = await findMachines({ category: "robot", sort: "activity" });
    assert.deepEqual(out, data);
    assert.equal(m.calls[0]!.origin, "https://api.xona-agent.com");
    assert.equal(m.calls[0]!.search, "?category=robot&sort=activity");
  });

  it("honours XPAY_MACHINES_ENDPOINT and an explicit endpoint", async () => {
    const m = mockFetch([() => json({ success: true, data: { total: 0, items: [], indexed_through_block: 1 } })]);
    restore = m.restore;
    process.env.XPAY_MACHINES_ENDPOINT = "http://localhost:4000/";
    await findMachines();
    await machineStats({ endpoint: "http://127.0.0.1:5000" });
    assert.equal(m.calls[0]!.href, "http://localhost:4000/api/machines");
    assert.equal(m.calls[1]!.href, "http://127.0.0.1:5000/api/machines/stats");
  });

  it("getMachine encodes the DID and keeps flags", async () => {
    const detail: MachineDetail = { ...machine(), flags: ["unrated", "no_activity"] };
    const m = mockFetch([(u) => (u.pathname.startsWith("/api/machines/") ? json({ success: true, data: detail }) : undefined)]);
    restore = m.restore;
    const out = await getMachine("did:peaq:4242");
    assert.deepEqual(out.flags, ["unrated", "no_activity"]);
    assert.equal(m.calls[0]!.pathname, "/api/machines/did%3Apeaq%3A4242");
  });

  it("getMachine throws MachineNotFoundError on 404", async () => {
    restore = mockFetch([() => json({ success: false, error: "not registered" }, 404)]).restore;
    await assert.rejects(getMachine("7"), (e) => e instanceof MachineNotFoundError && /"7"/.test(e.message));
  });

  it("rejects an invalid id before any request", async () => {
    const m = mockFetch([() => json({})]);
    restore = m.restore;
    await assert.rejects(getMachine("1; drop"), /not a machine id/);
    assert.equal(m.calls.length, 0);
  });

  it("surfaces backend errors and bad shapes", async () => {
    restore = mockFetch([() => json({ success: false, error: "indexer offline" }, 503)]).restore;
    await assert.rejects(machineStats(), /xpay\.machines: indexer offline/);
    restore();
    restore = mockFetch([() => json({ success: true })]).restore;
    await assert.rejects(machineStats(), /unexpected response shape/);
    restore();
    restore = mockFetch([() => new Response("<html>", { status: 502, statusText: "Bad Gateway" })]).restore;
    await assert.rejects(machineStats(), /502 Bad Gateway/);
  });

  it("times out with a clear error", async () => {
    // AbortSignal.timeout's timer is unref'd; hold the loop open while we hang.
    const hang: typeof fetch = (_u, init) =>
      new Promise((_r, reject) => {
        const keepAlive = setTimeout(() => {}, 5_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(init.signal!.reason);
        });
      });
    await assert.rejects(machineStats({ fetch: hang, timeoutMs: 20 }), /timed out after 20ms/);
  });
});

describe("summarizeMachineTrust", () => {
  it("unrated, bonded, no revenue", () => {
    const s = summarizeMachineTrust({ ...machine(), flags: ["unrated", "no_activity"] });
    assert.match(s, /^Unrated: registered and bonded but no revenue history yet and no recorded activity\./);
    assert.match(s, /no service endpoints/);
  });

  it("unbonded flag wins", () => {
    const s = summarizeMachineTrust({ ...machine(), flags: ["unrated", "unbonded"] });
    assert.match(s, /registered and not bonded/);
  });

  it("rated machine with revenue", () => {
    const s = summarizeMachineTrust({
      ...machine({ endpoints: ["https://robot.example/api"] }, {
        rating: "AA",
        score: 82,
        revenue_event_count: 14,
        activity_event_count: 30,
        event_count: 44,
        revenue_usd: 1234.5,
        revenue_trend: "up",
      }),
      flags: [],
    });
    assert.equal(s, "Rated AA (score 82/100), bonded: 14 revenue events totalling $1,234.50, revenue trend up.");
  });

  it("warns on negative flag, test machines, inactivity and degraded data", () => {
    const s = summarizeMachineTrust({
      ...machine({ active: false, category: "test" }, { rating: "Provisioned", degraded: true }),
      flags: ["negative_flag", "test_machine", "degraded_data"],
    });
    assert.match(s, /^Test machine/);
    assert.match(s, /negative credit event/);
    assert.match(s, /Provisioned: newly registered/);
    assert.match(s, /Currently inactive\./);
    assert.match(s, /incomplete/);
  });

  it("derives flags from credit when a list item has none", () => {
    const s = summarizeMachineTrust(machine({}, { bond_status: "none" }));
    assert.match(s, /registered and not bonded/);
  });
});

describe("machine MCP tools", () => {
  function fakeXPay(calls: unknown[]): XPay {
    return {
      findMachines: async (opts: unknown) => {
        calls.push(["find", opts]);
        return { total: 1, items: [machine()], indexed_through_block: 5 };
      },
      machineStats: async () => {
        calls.push(["stats"]);
        return { registered_total: 3 };
      },
      getMachine: async (id: string) => {
        calls.push(["get", id]);
        if (id === "404") throw new MachineNotFoundError(id);
        return { ...machine(), flags: ["unrated"] };
      },
    } as unknown as XPay;
  }

  it("are registered, read-only, and absent from spend annotations", () => {
    const { tools } = forClaude(fakeXPay([]));
    for (const name of ["xpay_machine_find", "xpay_machine_lookup"]) {
      assert.ok(tools.some((t) => t.name === name), name);
      assert.deepEqual(TOOL_ANNOTATIONS[name], { readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    }
    const lookup = tools.find((t) => t.name === "xpay_machine_lookup")!;
    assert.deepEqual((lookup.input_schema as { required: string[] }).required, ["id"]);
    const find = tools.find((t) => t.name === "xpay_machine_find")!;
    assert.match(find.description, /about 20 are robots/);
    assert.match(find.description, /none publish service endpoints/);
  });

  it("xpay_machine_find defaults to activity sort and folds in stats", async () => {
    const calls: unknown[] = [];
    const { handlers } = forClaude(fakeXPay(calls));
    const out = (await handlers.xpay_machine_find!({ category: "robot", include_stats: true })) as {
      total: number;
      items: Array<{ summary: string; operator: string }>;
      stats?: unknown;
    };
    assert.deepEqual(calls[0], [
      "find",
      {
        query: undefined,
        category: "robot",
        type: undefined,
        active: undefined,
        owner: undefined,
        rated: undefined,
        sort: "activity",
        limit: 20,
        offset: undefined,
        includeTest: undefined,
      },
    ]);
    assert.deepEqual(calls[1], ["stats"]);
    assert.equal(out.total, 1);
    assert.deepEqual(out.stats, { registered_total: 3 });
    assert.match(out.items[0]!.summary, /^Unrated/);
    assert.equal(out.items[0]!.operator, "0x2222222222222222222222222222222222222222");
  });

  it("xpay_machine_lookup returns a summary, and found:false on 404", async () => {
    const calls: unknown[] = [];
    const { handlers } = forClaude(fakeXPay(calls));
    const hit = (await handlers.xpay_machine_lookup!({ id: "did:peaq:4242" })) as { found: boolean; summary: string };
    assert.equal(hit.found, true);
    assert.match(hit.summary, /Unrated: registered and bonded/);
    const miss = (await handlers.xpay_machine_lookup!({ id: "404" })) as { found: boolean };
    assert.equal(miss.found, false);
    await assert.rejects(handlers.xpay_machine_lookup!({ id: "nope" }), /not a machine id/);
  });
});
