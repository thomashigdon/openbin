import type { BinItem } from '@/types';

const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

export function formatPrice(amount: number): string {
  return money.format(amount);
}

/** What an item line is worth: unit price × quantity (no quantity = one). Null when unpriced. */
export function itemTotal(item: Pick<BinItem, 'unit_price' | 'quantity'>): number | null {
  if (item.unit_price == null) return null;
  return Math.round(item.unit_price * (item.quantity ?? 1) * 100) / 100;
}

/** YYYY-MM-DD for a date input, from a plain date or an ISO timestamp. */
export function toDateInput(value: string | null | undefined): string {
  if (!value) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

export function formatPurchaseDate(value: string | null | undefined): string {
  const d = toDateInput(value);
  if (!d) return '';
  // Parse as a local date so the day doesn't shift with the timezone.
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** One-line summary for an item row, e.g. "$12.99 · Amazon · Nov 2, 2026". Empty when there's nothing. */
export function itemDetailSummary(item: BinItem): string {
  const parts: string[] = [];
  if (item.unit_price != null) {
    const total = itemTotal(item);
    parts.push(item.quantity && item.quantity > 1 && total != null
      ? `${formatPrice(item.unit_price)} ea (${formatPrice(total)})`
      : formatPrice(item.unit_price));
  }
  if (item.purchased_from) parts.push(item.purchased_from);
  const date = formatPurchaseDate(item.purchased_at);
  if (date) parts.push(date);
  return parts.join(' · ');
}
