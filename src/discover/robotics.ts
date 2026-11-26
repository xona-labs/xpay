/**
 * Robotics category for discovery: services a robot, drone, sensor or other
 * machine agent can pay for today.
 *
 * There is no "robotics" tag in any catalog, so the category is a curated set
 * of facets. Each facet has one search query (sent to the catalogs exactly
 * like a normal discover() query) and a pattern every result must match in its
 * name, description, URL, category or tags. The pattern is what keeps the
 * category honest: catalog search is fuzzy ("weather" also returns flight
 * trackers, "image analysis" returns image generators), so anything that does
 * not plainly describe a machine-useful capability is dropped. Nothing is
 * invented: every result is a real catalog listing, ranked as the catalogs
 * ranked it.
 */

import type { Resource } from "../types.js";

export interface RoboticsFacet {
  id: string;
  label: string;
  /** Catalog search query for this facet. */
  query: string;
  /** A result belongs to the facet when its text matches this. */
  match: RegExp;
  /** ...unless it also matches this. */
  exclude?: RegExp;
  /**
   * Word stems in a caller's query that point at this facet
   * ("camera" → vision, "route" → maps). Prefix-matched per word.
   */
  intent: string[];
}

/** Facet order is the round-robin order of mixed results. */
export const ROBOTICS_FACETS: RoboticsFacet[] = [
  {
    id: "vision",
    intent: ["camera", "image", "photo", "picture", "frame", "video", "vision", "see", "detect", "obstacle", "object", "recogni", "identif", "inspect", "count"],
    label: "Vision / image analysis",
    query: "object detection",
    match:
      /object[- ]?(detect|count|recogni)|bounding box|image (analysis|classif|recogni|caption|understanding|tagging)|analy[sz]e (an |the )?(image|photo)|describe (an |the )?(image|photo)|computer vision|\bvision\b|face detect|segmentation|pose estimat|depth estimat/,
    exclude: /image generat|generate (an |the )?image|text[- ]to[- ]image|ai art/,
  },
  {
    id: "ocr",
    intent: ["ocr", "text", "read", "sign", "label", "document", "receipt", "barcode", "scan"],
    label: "OCR / text from images",
    query: "ocr",
    match: /\bocr\b|optical character|extract text from (an |a )?(image|photo|scan)|text recognition/,
  },
  {
    id: "maps",
    intent: ["map", "route", "routing", "navigat", "direction", "address", "location", "geocod", "place", "gps", "coordinat", "path", "distance", "elevation", "delivery"],
    label: "Maps / geocoding / routing",
    query: "geocoding",
    match:
      /geocod|\brouting\b|turn[- ]by[- ]turn|driving directions|\bdirections\b|distance matrix|isochrone|elevation|openstreetmap|nominatim|map tiles?|place (search|lookup)|points? of interest|\bgeofenc/,
  },
  {
    id: "weather",
    intent: ["weather", "rain", "wind", "temperature", "forecast", "climate", "storm", "air", "environment", "flood"],
    label: "Weather / environment",
    query: "weather",
    match: /weather|air quality|\baqi\b|precipitation|open-meteo|uv index|pollen|wind speed|\btides?\b|earthquake|wildfire/,
  },
  {
    id: "compute",
    intent: ["llm", "model", "inference", "reason", "plan", "gpu", "compute", "embedding", "think", "chat"],
    label: "Compute / inference",
    query: "llm inference",
    match: /inference|chat\/?completions?|\bllm\b|language model|\bgpu\b|embeddings?\b|vision[- ]language|\bvlm\b/,
  },
  {
    id: "sensor",
    intent: ["sensor", "iot", "telemetry", "device", "fleet", "calibrat", "anomal", "lidar"],
    label: "Sensor / IoT data",
    query: "iot sensor",
    match: /\biot\b|sensor|telemetry|smart home|device data|\bdepin\b|\blidar\b|satellite imagery|\bgps\b/,
  },
  {
    id: "translation",
    intent: ["translat", "language", "multilingual"],
    label: "Translation",
    query: "translate",
    match: /translat/,
  },
  {
    id: "speech",
    intent: ["speech", "voice", "audio", "talk", "speak", "transcri", "listen", "tts"],
    label: "Speech / voice",
    query: "speech to text",
    match: /speech[- ]to[- ]text|text[- ]to[- ]speech|\btranscri|\btts\b|\bstt\b|voice synth|speech recogni/,
  },
];

export const DISCOVER_CATEGORIES = ["robotics"] as const;
export type DiscoverCategory = (typeof DISCOVER_CATEGORIES)[number];

/** The text a facet pattern is matched against: what the listing says it does. */
function facetText(r: Resource): string {
  const m = r.metadata ?? {};
  const tags = Array.isArray(m.tags) ? m.tags.join(" ") : "";
  return [r.resource, m.name, m.description, m.category, tags]
    .filter((v) => typeof v === "string" && v)
    .join(" ")
    .toLowerCase();
}

/** The first facet this resource belongs to, or undefined. */
export function roboticsFacetOf(r: Resource, facets: RoboticsFacet[] = ROBOTICS_FACETS): RoboticsFacet | undefined {
  const text = facetText(r);
  return facets.find((f) => f.match.test(text) && !f.exclude?.test(text));
}

/**
 * Facets a free-text query points at, by its words' stems ("weather on my
 * route" → weather, maps; "detect obstacles in the camera frame" → vision).
 * Empty when the query names none of them.
 */
export function facetsForQuery(query: string, facets: RoboticsFacet[] = ROBOTICS_FACETS): RoboticsFacet[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  return facets.filter((f) => words.some((w) => f.intent.some((stem) => w.startsWith(stem))));
}

/** Copy of `r` tagged with its facet (cached catalog objects are never mutated). */
export function tagFacet(r: Resource, facet: RoboticsFacet): Resource {
  return { ...r, metadata: { ...(r.metadata ?? {}), roboticsFacet: facet.id } };
}

/**
 * Round-robin across per-facet result lists, deduped by method + URL, up to
 * `limit`. Keeps each list's own ranking, so every facet gets its best hits
 * near the top instead of one facet filling the page.
 */
export function interleave(lists: Resource[][], limit: number): Resource[] {
  const out: Resource[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const list of lists) {
      const r = list[i];
      if (!r || out.length >= limit) continue;
      const key = `${r.method} ${r.resource}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}
