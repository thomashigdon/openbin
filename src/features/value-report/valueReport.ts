import { itemTotal } from '@/lib/itemValue';
import type { Bin, BinItem } from '@/types';

export interface ReportBin {
  id: string;
  name: string;
  items: BinItem[];
  /** Sum of priced lines. */
  total: number;
}

export interface ReportArea {
  name: string;
  bins: ReportBin[];
  total: number;
}

export interface ValueReport {
  areas: ReportArea[];
  total: number;
  itemCount: number;
  pricedCount: number;
}

const UNASSIGNED = 'No area';

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Group bins by area and total what their items are worth. With `pricedOnly`, unpriced
 * items (and bins left empty by that) are dropped; counts always cover every item.
 */
export function buildValueReport(bins: Bin[], { pricedOnly = false } = {}): ValueReport {
  const byArea = new Map<string, ReportBin[]>();
  let total = 0;
  let itemCount = 0;
  let pricedCount = 0;

  for (const bin of bins) {
    const all = Array.isArray(bin.items) ? bin.items : [];
    itemCount += all.length;
    let binTotal = 0;
    for (const item of all) {
      const t = itemTotal(item);
      if (t != null) {
        binTotal += t;
        pricedCount++;
      }
    }
    const items = pricedOnly ? all.filter((i) => i.unit_price != null) : all;
    if (items.length === 0) continue;
    total += binTotal;
    const area = bin.area_name || UNASSIGNED;
    const list = byArea.get(area) ?? [];
    list.push({ id: bin.id, name: bin.name, items, total: cents(binTotal) });
    byArea.set(area, list);
  }

  const areas = [...byArea.entries()]
    .map(([name, areaBins]) => ({
      name,
      bins: areaBins.sort((a, b) => a.name.localeCompare(b.name)),
      total: cents(areaBins.reduce((sum, b) => sum + b.total, 0)),
    }))
    // Areas A–Z, with bins that have no area last.
    .sort((a, b) => (a.name === UNASSIGNED ? 1 : b.name === UNASSIGNED ? -1 : a.name.localeCompare(b.name)));

  return { areas, total: cents(total), itemCount, pricedCount };
}

function csvCell(value: string | number | null | undefined): string {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function valueReportCsv(report: ValueReport): string {
  const rows = [['Area', 'Bin', 'Item', 'Quantity', 'Unit Price', 'Total', 'Purchased', 'Store', 'Barcode']];
  for (const area of report.areas) {
    for (const bin of area.bins) {
      for (const item of bin.items) {
        const t = itemTotal(item);
        rows.push([
          area.name,
          bin.name,
          item.name,
          String(item.quantity ?? 1),
          item.unit_price != null ? item.unit_price.toFixed(2) : '',
          t != null ? t.toFixed(2) : '',
          item.purchased_at?.slice(0, 10) ?? '',
          item.purchased_from ?? '',
          item.barcode ?? '',
        ]);
      }
    }
  }
  return `${rows.map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}
