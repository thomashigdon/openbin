/**
 * Staged purchases: things you bought (online orders, in-store photos) that are
 * waiting to be put into a bin. Pure helpers live here (input validation, title
 * shortening, bin suggestions); routes live in routes/stagedPurchases.ts.
 */
import { ValidationError } from './httpErrors.js';
import { normalizeForCompare, normalizeForMatch, simplePluralStem } from './inventoryMatch.js';
import { stripUnicodeControl } from './validation.js';

export const MAX_TITLE_LEN = 500;
export const MAX_NAME_LEN = 200;
export const MAX_BATCH = 200;
const MAX_SHORT_NAME = 80;

export interface StagedPurchaseInput {
  source: string;
  externalId: string | null;
  productKey: string | null;
  store: string;
  orderRef: string;
  title: string;
  name: string;
  quantity: number | null;
  price: number | null;
  currency: string | null;
  purchasedAt: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  delivered: boolean;
  cancelled: boolean;
}

// ── Input validation ────────────────────────────────────────────────

function optString(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw new ValidationError(`${field} must be a string`);
  const s = stripUnicodeControl(v.trim());
  if (s.length > max) throw new ValidationError(`${field} too long (max ${max})`);
  return s || null;
}

function optUrl(v: unknown, field: string): string | null {
  const s = optString(v, field, 2000);
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ValidationError(`${field} must be a URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ValidationError(`${field} must be http(s)`);
  return u.toString();
}

function optPositiveInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) throw new ValidationError(`${field} must be a positive number`);
  return Math.min(Math.floor(n), 1_000_000);
}

function optPrice(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new ValidationError('price must be a non-negative number');
  return Math.round(n * 100) / 100;
}

function optDate(v: unknown): string | null {
  const s = optString(v, 'purchased_at', 40);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new ValidationError('purchased_at must be a date');
  // Keep plain dates as-is (no timezone shift); normalize full timestamps.
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(t).toISOString();
}

const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,49}$/;

export function parseStagedInput(raw: unknown, index = 0): StagedPurchaseInput {
  if (!raw || typeof raw !== 'object') throw new ValidationError(`purchases[${index}] must be an object`);
  const r = raw as Record<string, unknown>;
  const where = (f: string) => `purchases[${index}].${f}`;

  const source = typeof r.source === 'string' ? r.source.trim().toLowerCase() : '';
  if (!SOURCE_RE.test(source)) throw new ValidationError(`${where('source')} must be a short lowercase id like "amazon"`);

  const title = optString(r.title, where('title'), MAX_TITLE_LEN);
  if (!title) throw new ValidationError(`${where('title')} is required`);
  const name = optString(r.name, where('name'), MAX_NAME_LEN) ?? shortenTitle(title);
  const externalId = optString(r.external_id, where('external_id'), 200);
  const productKey = optString(r.product_key, where('product_key'), 300) ?? defaultProductKey(source, title);

  return {
    source,
    externalId,
    productKey,
    store: optString(r.store, where('store'), 100) ?? '',
    orderRef: optString(r.order_ref, where('order_ref'), 100) ?? '',
    title,
    name,
    quantity: optPositiveInt(r.quantity, where('quantity')),
    price: optPrice(r.price),
    currency: optString(r.currency, where('currency'), 10),
    purchasedAt: optDate(r.purchased_at),
    productUrl: optUrl(r.product_url, where('product_url')),
    imageUrl: optUrl(r.image_url, where('image_url')),
    delivered: r.delivered === undefined ? true : r.delivered === true,
    cancelled: r.cancelled === true,
  };
}

export function parseStagedBatch(body: unknown): StagedPurchaseInput[] {
  const list = (body as { purchases?: unknown } | null)?.purchases;
  if (!Array.isArray(list)) throw new ValidationError('purchases must be an array');
  if (list.length === 0) throw new ValidationError('purchases must not be empty');
  if (list.length > MAX_BATCH) throw new ValidationError(`purchases must contain at most ${MAX_BATCH} entries`);
  return list.map((p, i) => parseStagedInput(p, i));
}

/** Product identity used to learn from past sorts/skips when the source gives no SKU. */
export function defaultProductKey(source: string, title: string): string {
  return `${source}:${normalizeForCompare(title).slice(0, 200)}`;
}

/**
 * Turn a store listing title ("DIVANC 550Pcs 304 Stainless Steel Wood Screws Assortment Kit, Phillips
 * Pan Head ... ") into something that reads like an inventory item. Cuts at the first separator after
 * a few words, then at a word boundary.
 */
export function shortenTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  const separators = [', ', ' - ', ' – ', ' — ', ' | ', ' (', '; ', ': '];
  let cut = t.length;
  for (const sep of separators) {
    const at = t.indexOf(sep);
    if (at > 0 && at < cut && t.slice(0, at).split(' ').length >= 3) cut = at;
  }
  let s = t.slice(0, cut).trim();
  if (s.length > MAX_SHORT_NAME) {
    const at = s.lastIndexOf(' ', MAX_SHORT_NAME);
    s = s.slice(0, at > 20 ? at : MAX_SHORT_NAME).trim();
  }
  return s.replace(/[,;:\-–—|]+$/, '').trim() || t.slice(0, MAX_SHORT_NAME);
}

// ── Bin suggestions ─────────────────────────────────────────────────

export interface SuggestableBin {
  id: string;
  name: string;
  area_name: string;
  icon: string;
  color: string;
  tags: string[];
  items: string[];
}

export interface BinSuggestion {
  bin_id: string;
  bin_name: string;
  area_name: string;
  icon: string;
  color: string;
  reason: 'history' | 'order' | 'shopping_list' | 'match';
  detail: string;
  score: number;
  /** False for a word match on a single item word: worth showing, not worth one-tap prominence. */
  confident: boolean;
}

export interface SuggestableItem {
  name: string;
  title: string;
  product_key: string | null;
  /** `${source}|${order_ref}` — other items from the same order you've already put away are a strong hint. */
  order_key?: string | null;
}

// Listing words that say nothing about where a thing lives.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'for', 'with', 'without', 'of', 'to', 'in', 'on', 'by', 'at', 'as', 'is', 'it',
  'from', 'into', 'your', 'you', 'our', 'this', 'that', 'all', 'any', 'per', 'via', 'no', 'not', 'be',
  'pack', 'pk', 'pcs', 'pc', 'piece', 'count', 'ct', 'qty', 'lot', 'bundle', 'pair',
  'inch', 'ft', 'feet', 'foot', 'oz', 'lb', 'lbs', 'mm', 'cm', 'ml', 'gallon', 'liter', 'size', 'x',
  'new', 'premium', 'quality', 'compatible', 'professional', 'pro', 'heavy', 'duty', 'value', 'ultra',
  'version', 'model', 'gen', 'generation', 'edition', 'upgraded', 'design', 'durable', 'easy', 'use',
]);

function tokens(s: string): string[] {
  const n = normalizeForMatch(s);
  if (!n) return [];
  const out: string[] = [];
  for (const raw of n.split(' ')) {
    if (raw.length < 2 || /^\d+$/.test(raw) || STOPWORDS.has(raw)) continue;
    const stem = simplePluralStem(raw);
    if (!STOPWORDS.has(stem)) out.push(stem);
  }
  return out;
}

const FIELD_WEIGHT = { name: 3, tags: 2, items: 2, area: 1 } as const;
type Field = keyof typeof FIELD_WEIGHT;

interface BinIndex {
  bin: SuggestableBin;
  fields: Map<string, Field>; // token → strongest field it appears in
}

function indexBin(bin: SuggestableBin): BinIndex {
  const fields = new Map<string, Field>();
  const add = (text: string, field: Field) => {
    for (const t of tokens(text)) {
      const prev = fields.get(t);
      if (!prev || FIELD_WEIGHT[field] > FIELD_WEIGHT[prev]) fields.set(t, field);
    }
  };
  add(bin.area_name, 'area');
  for (const i of bin.items) add(i, 'items');
  for (const t of bin.tags) add(t, 'tags');
  add(bin.name, 'name');
  return { bin, fields };
}

export interface SuggesterContext {
  bins: SuggestableBin[];
  /** product_key → bin_id → number of times sorted there */
  history: Map<string, Map<string, number>>;
  /** order_key → bin_id → number of items from that order sorted there */
  orderSiblings?: Map<string, Map<string, number>>;
  shoppingList: Array<{ name: string; origin_bin_id: string | null }>;
}

const HISTORY_SCORE = 1000;
const SHOPPING_LIST_SCORE = 500;
const ORDER_SIBLING_SCORE = 300;
/** Part-word matches ("board" in "breadboard") count, but less than whole words. */
const PARTIAL_WEIGHT = 0.5;
const MIN_PARTIAL_LEN = 4;
const TOP_N = 3;

/** Build a suggestion function over a location's bins. Bins should already be filtered to ones the user can add to. */
export function buildSuggester(ctx: SuggesterContext): (item: SuggestableItem) => BinSuggestion[] {
  const indexed = ctx.bins.map(indexBin);
  const byId = new Map(indexed.map((b) => [b.bin.id, b]));
  const df = new Map<string, number>();
  for (const b of indexed) for (const t of b.fields.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = indexed.length;
  const idf = (t: string) => Math.log(1 + n / (1 + (df.get(t) ?? 0)));
  // Half a part-word match on one bin item: below that it's noise. Scales with the number of bins (via idf).
  const minMatchScore = 0.5 * Math.log(1 + n / 2);
  const shopping = ctx.shoppingList
    .filter((e) => e.origin_bin_id && byId.has(e.origin_bin_id))
    .map((e) => ({ tokens: new Set(tokens(e.name)), binId: e.origin_bin_id! }))
    .filter((e) => e.tokens.size > 0);

  return (item) => {
    const scores = new Map<string, { score: number; reason: BinSuggestion['reason']; detail: string; rank: number; confident: boolean }>();
    const RANK: Record<BinSuggestion['reason'], number> = { history: 4, shopping_list: 3, order: 2, match: 1 };
    const bump = (binId: string, score: number, reason: BinSuggestion['reason'], detail: string, confident = true) => {
      const rank = RANK[reason];
      const cur = scores.get(binId);
      if (!cur) {
        scores.set(binId, { score, reason, detail, rank, confident });
      } else {
        cur.score += score;
        cur.confident ||= confident;
        if (rank > cur.rank) Object.assign(cur, { reason, detail, rank });
      }
    };

    // 1. Same product sorted before.
    const past = item.product_key ? ctx.history.get(item.product_key) : undefined;
    if (past) {
      for (const [binId, count] of past) {
        if (!byId.has(binId)) continue;
        bump(binId, HISTORY_SCORE * count, 'history', count > 1 ? `You put this here ${count} times before` : 'You put this here before');
      }
    }

    // 1b. Other things from the same order went here.
    const siblings = item.order_key ? ctx.orderSiblings?.get(item.order_key) : undefined;
    if (siblings) {
      for (const [binId, count] of siblings) {
        if (!byId.has(binId)) continue;
        bump(binId, ORDER_SIBLING_SCORE * count, 'order', count > 1 ? `${count} other things from this order are here` : 'Something else from this order is here');
      }
    }

    // Query tokens: the short name counts fully, extra words from the full listing title count less.
    const nameTokens = tokens(item.name);
    const weights = new Map<string, number>();
    for (const t of nameTokens) weights.set(t, 1);
    for (const t of tokens(item.title)) if (!weights.has(t)) weights.set(t, 0.6);
    const itemTokenSet = new Set(weights.keys());

    // 2. On the shopping list from a bin.
    for (const entry of shopping) {
      let hit = 0;
      for (const t of entry.tokens) if (itemTokenSet.has(t)) hit++;
      if (hit / entry.tokens.size >= 0.6) bump(entry.binId, SHOPPING_LIST_SCORE, 'shopping_list', 'On your shopping list from this bin');
    }

    // 3. Words in common with the bin's name, tags, items and area.
    for (const b of indexed) {
      let score = 0;
      const hits: Array<{ t: string; s: number; strong: boolean }> = [];
      for (const [t, w] of weights) {
        let field = b.fields.get(t);
        let partial = 1;
        if (!field && t.length >= MIN_PARTIAL_LEN) {
          for (const [bt, bf] of b.fields) {
            if (bt.length >= MIN_PARTIAL_LEN && (bt.includes(t) || t.includes(bt))
              && (!field || FIELD_WEIGHT[bf] > FIELD_WEIGHT[field])) field = bf;
          }
          partial = PARTIAL_WEIGHT;
        }
        if (!field) continue;
        const s = w * partial * idf(t) * FIELD_WEIGHT[field];
        score += s;
        hits.push({ t, s, strong: partial === 1 && (field === 'name' || field === 'tags') });
      }
      if (score > 0 && score >= minMatchScore) {
        hits.sort((x, y) => y.s - x.s);
        const words = hits.slice(0, 3).map((h) => `“${h.t}”`).join(', ');
        bump(b.bin.id, score, 'match', `Matches ${words}`, hits.length >= 2 || hits.some((h) => h.strong));
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, TOP_N)
      .map(([binId, s]) => {
        const bin = byId.get(binId)!.bin;
        return {
          bin_id: bin.id,
          bin_name: bin.name,
          area_name: bin.area_name,
          icon: bin.icon,
          color: bin.color,
          reason: s.reason,
          detail: s.detail,
          score: Math.round(s.score * 100) / 100,
          confident: s.confident,
        };
      });
  };
}
