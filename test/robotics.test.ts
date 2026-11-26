import "./helpers.js";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearDiskCache, json, mockFetch } from "./helpers.js";
import { discover, invalidateCache, lastDiscoverWarnings } from "../src/discover/index.js";
import { ROBOTICS_FACETS, facetsForQuery, interleave, roboticsFacetOf } from "../src/discover/robotics.js";
import { forClaude } from "../src/tools/index.js";
import type { Resource } from "../src/types.js";
import type { XPay } from "../src/index.js";

function res(url: string, description: string, extra: Record<string, unknown> = {}): Resource {
  return {
    resource: url,
    type: "http",
    method: "POST",
    x402Version: 2,
    accepts: [{ asset: "USDC", payTo: "", scheme: "exact", network: "eip155:8453" }],
    metadata: { name: new URL(url).hostname, description, ...extra },
  } as Resource;
}

describe("robotics facets", () => {
  it("match capability text and skip look-alikes", () => {
    const facet = (r: Resource) => roboticsFacetOf(r)?.id;
    assert.equal(facet(res("https://a.example/v1/object-detect", "Find objects in an image with bounding boxes")), "vision");
    assert.equal(facet(res("https://a.example/ocr", "OCR a scanned PDF into clean text")), "ocr");
    assert.equal(facet(res("https://a.example/geo", "Forward geocoding via OpenStreetMap Nominatim")), "maps");
    assert.equal(facet(res("https://a.example/w", "Current weather at a latitude/longitude")), "weather");
    assert.equal(facet(res("https://a.example/llm", "LLM inference, OpenAI-compatible chat/completions")), "compute");
    assert.equal(facet(res("https://a.example/iot", "Sensor calibration for IoT fleets")), "sensor");
    assert.equal(facet(res("https://a.example/t", "Translate text between 21 languages")), "translation");
    assert.equal(facet(res("https://a.example/stt", "Speech-to-text: transcribe audio")), "speech");
    // Image generation is not vision; token risk "analysis" is nothing.
    assert.equal(facet(res("https://api.xona-agent.com/image/x", "AI image generation from your prompt")), undefined);
    assert.equal(facet(res("https://k.example/analysis", "Token risk analysis for Solana memecoins")), undefined);
    assert.equal(facet(res("https://f.example/flights", "Real-time flight tracking and airport operations")), undefined);
    // Text inside the input schema does not count.
    const sneaky = { ...res("https://s.example/x", "Memecoin screener"), inputSchema: { weather: { type: "string" } } };
    assert.equal(facet(sneaky as Resource), undefined);
  });

  it("read query intent from word stems", () => {
    const ids = (q: string) => facetsForQuery(q).map((f) => f.id);
    assert.deepEqual(ids("weather along my delivery route"), ["maps", "weather"]);
    assert.deepEqual(ids("detect obstacles in the camera frame"), ["vision"]);
    assert.deepEqual(ids("read a shipping label"), ["ocr"]);
    assert.deepEqual(ids("quarterly earnings"), []);
  });

  it("interleave round-robins and dedupes", () => {
    const a = [res("https://a.example/1", ""), res("https://a.example/2", "")];
    const b = [res("https://a.example/1", ""), res("https://b.example/1", "")];
    assert.deepEqual(
      interleave([a, b], 10).map((r) => r.resource),
      ["https://a.example/1", "https://a.example/2", "https://b.example/1"],
    );
    assert.equal(interleave([a, b], 2).length, 2);
  });
});

// ---------------------------------------------------------------- discover()

/** Xona's catalog: generators (must be dropped), one LLM and one TTS route. */
const XONA = [
  { slug: "image/gpt-image-2", method: "POST", description: "AI image generation using GPT Image 2", pricing: { amount: "0.04", network: "solana-mainnet" } },
  { slug: "llm/luna", method: "POST", description: "GPT Luna inference via OpenRouter, OpenAI-compatible chat completions", pricing: { amount: "0.0077", network: "solana-mainnet" } },
  { slug: "audio/speech-to-text", method: "POST", description: "Speech-to-text: transcribe audio from a URL", pricing: { amount: "0.02", network: "solana-mainnet" } },
];

/** Agentic Market search results per query, including fuzzy noise. */
const MARKET: Record<string, Array<{ name: string; category?: string; description: string; url: string }>> = {
  "object detection": [
    { name: "bild", description: "Find objects in an image with bounding boxes", url: "https://bild.example/v1/object-detect" },
    { name: "artgen", description: "Generate an image from a text prompt (text-to-image)", url: "https://art.example/gen" },
  ],
  ocr: [{ name: "relay", description: "Extract text from an image (Tesseract OCR)", url: "https://relay.example/image/ocr" }],
  geocoding: [
    { name: "geo", description: "Forward geocoding for AI agents", url: "https://geo.example/forward" },
    { name: "crime", description: "Crime profile for one reporting agency", url: "https://crime.example/agency" },
  ],
  weather: [
    { name: "FlightAware", category: "Travel", description: "Real-time flight tracking, airport operations", url: "https://flights.example/search" },
    { name: "wx", description: "Weather forecast and alerts for a latitude and longitude", url: "https://wx.example/forecast" },
  ],
  "llm inference": [{ name: "rent-gpu", description: "Serverless GPU inference for open models", url: "https://gpu.example/run" }],
  "iot sensor": [{ name: "iot", description: "Fleet anomaly detection over sensor telemetry", url: "https://iot.example/anomaly" }],
  translate: [{ name: "tr", description: "Translate text between 21 languages", url: "https://tr.example/translate" }],
  "speech to text": [{ name: "whisper", description: "Speech-to-text with Whisper", url: "https://whisper.example/stt" }],
  "weather along my delivery route": [
    { name: "wx", description: "Weather forecast and alerts for a latitude and longitude", url: "https://wx.example/forecast" },
    { name: "llm", description: "LLM inference for agents", url: "https://llm.example/chat" },
  ],
};

function catalogRoutes(failQuery?: string) {
  return [
    (u: URL) => (u.href === "https://api.xona-agent.com/x402-resources" ? json(XONA) : undefined),
    (u: URL) => {
      if (u.origin !== "https://api.agentic.market" || u.pathname !== "/v1/services/search") return undefined;
      const q = u.searchParams.get("q")!;
      if (q === failQuery) return json({ error: "boom" }, 500);
      const services = (MARKET[q] ?? []).map((s) => ({
        name: s.name,
        description: s.description,
        category: s.category ?? "Data",
        endpoints: [{ url: s.url, method: "POST", description: "", pricing: { amount: "0.01", network: "base" } }],
      }));
      return json({ services });
    },
  ];
}

const SOURCES = ["xona", "agenticmarket"];

describe("discover({ category: 'robotics' })", () => {
  let restore: () => void;
  beforeEach(() => {
    invalidateCache();
    clearDiskCache();
  });
  afterEach(() => restore?.());

  it("searches every facet, keeps only real matches, and interleaves them", async () => {
    const m = mockFetch(catalogRoutes());
    restore = m.restore;
    const out = await discover({ category: "robotics", sources: SOURCES, trust: false, limit: 20 });
    const urls = out.map((r) => r.resource);

    // One catalog search per facet.
    const queries = m.calls.filter((u) => u.pathname.endsWith("/search")).map((u) => u.searchParams.get("q"));
    assert.deepEqual(queries.sort(), ROBOTICS_FACETS.map((f) => f.query).sort());

    for (const noise of [
      "https://art.example/gen",
      "https://crime.example/agency",
      "https://flights.example/search",
      "https://api.xona-agent.com/image/gpt-image-2",
    ]) {
      assert.ok(!urls.includes(noise), `${noise} should be filtered out`);
    }
    // Every result is tagged, and the first page covers each facet once
    // before any repeats (round-robin in facet order).
    assert.ok(out.every((r) => typeof r.metadata?.roboticsFacet === "string"));
    assert.deepEqual(
      out.slice(0, 8).map((r) => r.metadata!.roboticsFacet),
      ["vision", "ocr", "maps", "weather", "compute", "sensor", "translation", "speech"],
    );
    // Xona's own matching routes are kept (and ranked first within the facet).
    assert.equal(out.find((r) => r.metadata!.roboticsFacet === "compute")!.resource, "https://api.xona-agent.com/llm/luna");
    assert.equal(out.find((r) => r.metadata!.roboticsFacet === "speech")!.resource, "https://api.xona-agent.com/audio/speech-to-text");
    assert.equal(new Set(urls).size, urls.length, "no duplicates");
  });

  it("defaults to 10 results and does not mutate cached catalog objects", async () => {
    restore = mockFetch(catalogRoutes()).restore;
    const out = await discover({ category: "robotics", sources: SOURCES, trust: false });
    assert.equal(out.length, 10);
    const plain = await discover({ query: "speech", sources: ["xona"], trust: false });
    assert.equal(plain[0]!.metadata?.roboticsFacet, undefined);
  });

  it("with a query: its matches lead, held to the facets it names", async () => {
    const m = mockFetch(catalogRoutes());
    restore = m.restore;
    const out = await discover({
      category: "robotics",
      query: "weather along my delivery route",
      sources: SOURCES,
      trust: false,
      limit: 5,
    });
    const queries = m.calls.filter((u) => u.pathname.endsWith("/search")).map((u) => u.searchParams.get("q")).sort();
    assert.deepEqual(queries, ["geocoding", "weather", "weather along my delivery route"]);
    assert.equal(out[0]!.resource, "https://wx.example/forecast");
    // "LLM inference" matched the query but not the facets it names.
    assert.ok(!out.some((r) => r.resource === "https://llm.example/chat"));
    assert.ok(out.every((r) => ["weather", "maps"].includes(r.metadata!.roboticsFacet as string)));
  });

  it("survives one facet's search failing", async () => {
    restore = mockFetch(catalogRoutes("ocr")).restore;
    const out = await discover({ category: "robotics", sources: ["agenticmarket"], trust: false, limit: 20 });
    assert.ok(out.length > 0);
    assert.ok(!out.some((r) => r.metadata!.roboticsFacet === "ocr"));
    assert.ok(lastDiscoverWarnings().some((w) => w.includes("ocr")));
  });

  it("rejects an unknown category", async () => {
    await assert.rejects(discover({ category: "toys" as never }), /unknown category "toys"/);
  });

  it("xpay_discover passes category through", async () => {
    let seen: unknown;
    const xpay = { discover: async (o: unknown) => ((seen = o), []) } as unknown as XPay;
    const { tools, handlers } = forClaude(xpay);
    const def = tools.find((t) => t.name === "xpay_discover")!;
    const props = (def.input_schema as { properties: Record<string, { enum?: string[] }> }).properties;
    assert.deepEqual(props.category!.enum, ["robotics"]);
    await handlers.xpay_discover!({ category: "robotics" });
    assert.equal((seen as { category: string }).category, "robotics");
  });
});
