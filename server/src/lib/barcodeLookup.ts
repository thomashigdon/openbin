import { query } from '../db.js';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('barcodeLookup');

export interface BarcodeProduct {
  name: string;
  brand: string | null;
  /** The product photo on the source's CDN; the app serves a copy at /api/barcodes/:code/image. */
  image_url: string | null;
  source: string;
}

type FetchFn = typeof fetch;

const TIMEOUT_MS = 6000;
/** Codes no service knew are asked about again after this long (products get added). */
const MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A service answered "no such product" (cacheable), vs. threw (outage, rate limit: not cacheable). */
type ProviderResult = BarcodeProduct | null;

async function getJson(fetchFn: FetchFn, url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetchFn(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'OpenBin (self-hosted inventory)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = res.ok || res.status === 404 ? await res.json().catch(() => null) : null;
  return { status: res.status, body };
}

function clean(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 200) : null;
}

/** General merchandise. The free trial tier allows ~100 lookups a day per IP, no key. */
async function upcItemDb(fetchFn: FetchFn, code: string): Promise<ProviderResult> {
  const { status, body } = await getJson(fetchFn, `https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`);
  // 400 = it doesn't consider this a valid code (bad check digit, unknown length): a definite miss.
  if (status === 404 || status === 400) return null;
  if (status !== 200) throw new Error(`upcitemdb HTTP ${status}`);
  const item = (body as { items?: Array<{ title?: unknown; brand?: unknown; images?: unknown }> })?.items?.[0];
  const name = clean(item?.title);
  if (!item || !name) return null;
  // Listings often link images over plain http; the image fetcher is https-only, so ask for https.
  const images = Array.isArray(item.images) ? item.images.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)) : [];
  const image = images.find((u) => u.startsWith('https://')) ?? images[0]?.replace(/^http:/, 'https:') ?? null;
  return { name, brand: clean(item.brand), image_url: image, source: 'upcitemdb' };
}

/** Food, cosmetics and household products. Free and open, no key. */
async function openFoodFacts(fetchFn: FetchFn, code: string): Promise<ProviderResult> {
  const { status, body } = await getJson(
    fetchFn,
    `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,image_front_small_url`,
  );
  if (status === 404) return null;
  if (status !== 200) throw new Error(`openfoodfacts HTTP ${status}`);
  const b = body as { status?: number; product?: { product_name?: unknown; brands?: unknown; image_front_small_url?: unknown } };
  const name = clean(b?.product?.product_name);
  if (b?.status !== 1 || !name) return null;
  const brand = clean(typeof b.product?.brands === 'string' ? b.product.brands.split(',')[0] : null);
  const image = clean(b.product?.image_front_small_url);
  return { name, brand, image_url: image?.startsWith('https://') ? image : null, source: 'openfoodfacts' };
}

const PROVIDERS = [upcItemDb, openFoodFacts];

interface CacheRow {
  name: string | null;
  brand: string | null;
  image_url: string | null;
  source: string | null;
  looked_up_at: string;
}

/**
 * Look up a product by barcode: cache first, then each public service in turn.
 * Returns null when nobody knows the code, or when lookups are disabled.
 */
export async function lookupBarcode(code: string, fetchFn: FetchFn = fetch): Promise<BarcodeProduct | null> {
  if (!config.barcodeLookupEnabled) return null;

  const cached = await query<CacheRow>('SELECT name, brand, image_url, source, looked_up_at FROM barcode_lookups WHERE code = $1', [code]);
  const hit = cached.rows[0];
  if (hit?.name) return { name: hit.name, brand: hit.brand, image_url: hit.image_url, source: hit.source ?? 'cache' };
  if (hit && Date.now() - Date.parse(hit.looked_up_at) < MISS_TTL_MS) return null;

  let product: BarcodeProduct | null = null;
  let failed = false;
  for (const provider of PROVIDERS) {
    try {
      product = await provider(fetchFn, code);
      if (product) break;
    } catch (err) {
      failed = true;
      log.warn(`Barcode lookup via ${provider.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Don't remember a miss if a service was down: it might have known the code.
  if (product || !failed) {
    const now = new Date().toISOString();
    await query(
      `INSERT INTO barcode_lookups (code, name, brand, image_url, source, looked_up_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO UPDATE SET name = excluded.name, brand = excluded.brand, image_url = excluded.image_url,
         source = excluded.source, looked_up_at = excluded.looked_up_at`,
      [code, product?.name ?? null, product?.brand ?? null, product?.image_url ?? null, product?.source ?? null, now],
    );
  }
  return product;
}
