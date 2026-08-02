/**
 * xona shop partner integration: product discovery across Google Shopping,
 * Amazon, and eBay behind xona's x402-paywalled /shop/search endpoint, and
 * image-based discovery (Google Lens) behind /shop/lens.
 *
 * Flow differs from zauth in one important way: both doors have a FREE
 * preflight (POST /api/shop/quote, POST /api/shop/lens/quote) that validates
 * the input server-side and reports the exact price a paid call would cost.
 * Callers should quote first, then pay: the paid doors reject bad input
 * (non-product query, unreachable image URL) but still charge for the
 * attempt, so the free quote is what keeps agents from paying for a call
 * that returns nothing. Searches are synchronous, so there is no polling
 * step.
 */

export const SHOP_BASE = process.env.XPAY_SHOP_ENDPOINT ?? "https://api.xona-agent.com";

/** Marketplaces the resource can fan out to. Price scales with how many are searched. */
export const SHOP_MARKETPLACES = ["google_shopping", "amazon", "ebay"] as const;

export interface ShopSearchParams {
  /** Free-text shopper query. The only required field; everything else overrides the server-side parse. */
  query: string;
  /** Restrict to a subset of google_shopping / amazon / ebay. Fewer marketplaces means a lower price. */
  marketplaces?: string[];
  price_min?: number;
  price_max?: number;
  /** new | open_box | refurbished | used | for_parts */
  condition?: string;
  /** relevance | price_asc | price_desc | rating | reviews | discount | newest */
  sort?: string;
  country?: string;
  /** Max results after merge/dedupe. Server default 20. */
  limit?: number;
}

export interface ShopQuote {
  success: boolean;
  is_product_query: boolean;
  price_usd: number;
  would_search: string[];
  intent?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Lens engine modes: identify = 1 Lens credit, shop = identify + marketplace fan-out. */
export const SHOP_LENS_MODES = ["identify", "shop"] as const;

export interface ShopLensParams {
  /** Publicly reachable http(s) image URL. Data URIs and uploads are not supported. */
  image_url: string;
  /** identify (default, cheaper) or shop (adds the marketplace price comparison). */
  mode?: string;
  /** Optional text refinement applied alongside the image ("in black", "size 10"). */
  q?: string;
  price_min?: number;
  price_max?: number;
  /** new | open_box | refurbished | used | for_parts */
  condition?: string;
  /** relevance | price_asc | price_desc | rating | reviews | discount | newest */
  sort?: string;
  country?: string;
  /** Max results. Server default 20. */
  limit?: number;
  /** mode=shop only: restrict the comparison to a subset of marketplaces (lowers the price). */
  marketplaces?: string[];
}

export interface ShopLensQuote {
  success: boolean;
  image_url_valid: boolean;
  mode: string;
  price_usd: number;
  [key: string]: unknown;
}

/**
 * The lens door only accepts a publicly reachable URL (SerpAPI fetches the
 * image, xona never proxies the bytes), so local files and base64 payloads
 * are bridged through xona's free public image host first: uploads land in
 * object storage with a public-read ACL and the returned URL passes the lens
 * validation. Everything below up to fetchShopLensQuote implements that
 * bridge.
 */

/**
 * Cap on bytes we will upload. The host itself allows far more, but a lens
 * image is a product photo; anything bigger than this is almost certainly a
 * mistake (raw video frame, wrong file) and would waste upload time before
 * the paid call even starts.
 */
export const SHOP_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

/** Image types the upload endpoint accepts, keyed by magic bytes. */
function sniffImageMime(buf: Uint8Array): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
  return null;
}

/**
 * Upload image bytes to xona's public image host and return the public URL.
 * Free (no wallet): this is the general-purpose upload endpoint, not an x402
 * door. The type is sniffed from magic bytes rather than trusted from the
 * caller, because the endpoint rejects non-image types anyway.
 */
export async function uploadShopImage(bytes: Uint8Array, filename?: string): Promise<string> {
  if (bytes.length === 0) throw new Error("image is empty");
  if (bytes.length > SHOP_IMAGE_MAX_BYTES) {
    throw new Error(`image is ${bytes.length} bytes; max ${SHOP_IMAGE_MAX_BYTES} (is this really a product photo?)`);
  }
  const mime = sniffImageMime(bytes);
  if (!mime) throw new Error("unrecognized image format: expected JPEG, PNG, GIF, or WebP");

  const form = new FormData();
  const ext = mime.split("/")[1];
  form.append("image", new Blob([bytes as BlobPart], { type: mime }), filename ?? `lens-image.${ext}`);

  const res = await fetch(`${SHOP_BASE}/api/upload/image`, { method: "POST", body: form });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : text.slice(0, 200);
    throw new Error(`image upload ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const url = (data as { data?: { url?: unknown } })?.data?.url;
  if (typeof url !== "string" || !url) {
    throw new Error("image upload succeeded but no URL came back");
  }
  return url;
}

export interface LensImageInput {
  /** Publicly reachable http(s) URL: used as-is, no upload. */
  image_url?: string;
  /** Local file path: read and uploaded to xona's public image host first. */
  image_path?: string;
  /** Base64 image bytes (raw or data URI): uploaded to xona's public image host first. */
  image_base64?: string;
}

/**
 * Resolve whichever image input the caller provided into the public URL the
 * lens door requires. Exactly one of the three fields must be set: silently
 * preferring one over another would hide a caller bug (two different images).
 */
export async function resolveLensImageUrl(input: LensImageInput): Promise<{ image_url: string; uploaded: boolean }> {
  const provided = (["image_url", "image_path", "image_base64"] as const).filter((k) => input[k]);
  if (provided.length !== 1) {
    throw new Error(
      `provide exactly one of image_url, image_path, image_base64 (got ${provided.length ? provided.join(" + ") : "none"})`,
    );
  }

  if (input.image_url) return { image_url: input.image_url, uploaded: false };

  let bytes: Uint8Array;
  let filename: string | undefined;
  if (input.image_path) {
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    bytes = new Uint8Array(await readFile(input.image_path));
    filename = basename(input.image_path);
  } else {
    // Accept both a bare base64 string and a full data URI.
    const b64 = input.image_base64!.replace(/^data:[^;,]+;base64,/, "").replace(/\s/g, "");
    bytes = new Uint8Array(Buffer.from(b64, "base64"));
  }

  return { image_url: await uploadShopImage(bytes, filename), uploaded: true };
}

/**
 * Free preflight against /api/shop/lens/quote. Validates the image URL is a
 * publicly reachable http(s) URL (the dominant failure mode) and reports the
 * exact price the paid call would cost for the requested mode. No wallet, no
 * Lens credit spent.
 */
export async function fetchShopLensQuote(params: ShopLensParams): Promise<ShopLensQuote> {
  const res = await fetch(`${SHOP_BASE}/api/shop/lens/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : text.slice(0, 200);
    throw new Error(`shop lens quote ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return data as ShopLensQuote;
}

/** Free preflight against /api/shop/quote. No wallet, no SerpAPI credit spent. */
export async function fetchShopQuote(params: ShopSearchParams): Promise<ShopQuote> {
  const res = await fetch(`${SHOP_BASE}/api/shop/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message: unknown }).message)
        : text.slice(0, 200);
    throw new Error(`shop quote ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return data as ShopQuote;
}

/**
 * Search results carry per-product fields the typical agent never reads
 * (image URLs, marketplace position, internal scoring). Trim each product to
 * the comparison-relevant fields; use the raw payload when full detail
 * matters (CLI --json).
 */
export function compactShopResult(data: unknown): unknown {
  if (typeof data !== "object" || data === null) return data;
  const { results, marketplace_comparison, ...rest } = data as Record<string, unknown>;
  if (!Array.isArray(results)) return data;
  return {
    ...rest,
    results: results.map(compactProduct),
    // Lens mode=shop nests a second result list: the marketplace comparison
    // run on the product name derived from the image.
    ...(marketplace_comparison !== undefined
      ? { marketplace_comparison: compactShopResult(marketplace_comparison) }
      : {}),
  };
}

function compactProduct(p: unknown): unknown {
  if (typeof p !== "object" || p === null) return p;
  const {
    image: _image,
    product_id: _pid,
    position: _pos,
    sponsored: _sponsored,
    relevance_score: _score,
    badges: _badges,
    ...keep
  } = p as Record<string, unknown>;
  return keep;
}
