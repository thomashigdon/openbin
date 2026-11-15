import { ValidationError } from './httpErrors.js';
import { stripUnicodeControl } from './validation.js';

/** Purchase details and barcode an item can carry. `undefined` = not given (leave as is). */
export interface ItemDetailsInput {
  unit_price?: number | null;
  purchased_at?: string | null;
  purchased_from?: string | null;
  barcode?: string | null;
}

export const ITEM_DETAIL_FIELDS = ['unit_price', 'purchased_at', 'purchased_from', 'barcode'] as const;

const MAX_PRICE = 10_000_000;
const MAX_STORE_LEN = 100;

/**
 * UPC-A, UPC-E, EAN-8, EAN-13 and GTIN-14 are all 8–14 digits. Scanners and people
 * add spaces or dashes; strip them. Returns null when the input isn't a barcode.
 */
export function normalizeBarcode(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, '');
  return /^\d{8,14}$/.test(digits) ? digits : null;
}

function parsePrice(v: unknown): number | null {
  if (v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/^\$/, '')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PRICE) {
    throw new ValidationError('unit_price must be a non-negative number');
  }
  return Math.round(n * 100) / 100;
}

function parseDate(v: unknown): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new ValidationError('purchased_at must be a date');
  const s = v.trim();
  if (Number.isNaN(Date.parse(s))) throw new ValidationError('purchased_at must be a date');
  // Keep plain dates as-is (no timezone shift); normalize full timestamps.
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date(s).toISOString();
}

function parseStore(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== 'string') throw new ValidationError('purchased_from must be a string');
  const s = stripUnicodeControl(v.trim());
  if (s.length > MAX_STORE_LEN) throw new ValidationError(`purchased_from too long (max ${MAX_STORE_LEN})`);
  return s || null;
}

function parseBarcode(v: unknown): string | null {
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new ValidationError('barcode must be a string');
  const code = normalizeBarcode(v);
  if (!code) throw new ValidationError('barcode must be 8–14 digits (UPC/EAN)');
  return code;
}

/** Validate the detail fields present on `raw`; absent fields stay undefined. */
export function parseItemDetails(raw: Record<string, unknown>): ItemDetailsInput {
  const out: ItemDetailsInput = {};
  if (raw.unit_price !== undefined) out.unit_price = parsePrice(raw.unit_price);
  if (raw.purchased_at !== undefined) out.purchased_at = parseDate(raw.purchased_at);
  if (raw.purchased_from !== undefined) out.purchased_from = parseStore(raw.purchased_from);
  if (raw.barcode !== undefined) out.barcode = parseBarcode(raw.barcode);
  return out;
}
