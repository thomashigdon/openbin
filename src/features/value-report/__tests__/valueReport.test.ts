// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { itemDetailSummary, itemTotal } from '@/lib/itemValue';
import type { Bin, BinItem } from '@/types';
import { buildValueReport, valueReportCsv } from '../valueReport';

const item = (name: string, extra: Partial<BinItem> = {}): BinItem => ({ id: name, name, quantity: null, ...extra });
const bin = (name: string, area: string, items: BinItem[]) => ({ id: name, name, area_name: area, items }) as unknown as Bin;

describe('itemTotal', () => {
  it('multiplies by quantity and treats no quantity as one', () => {
    expect(itemTotal({ unit_price: 2.5, quantity: 3 })).toBe(7.5);
    expect(itemTotal({ unit_price: 19.99, quantity: null })).toBe(19.99);
    expect(itemTotal({ unit_price: null, quantity: 4 })).toBeNull();
  });
});

describe('itemDetailSummary', () => {
  it('summarizes price, store and date', () => {
    expect(itemDetailSummary(item('Drill', { unit_price: 129, purchased_from: 'Home Depot', purchased_at: '2026-03-04' })))
      .toBe('$129.00 · Home Depot · Mar 4, 2026');
    expect(itemDetailSummary(item('Batteries', { unit_price: 1.25, quantity: 4 }))).toBe('$1.25 ea ($5.00)');
    expect(itemDetailSummary(item('Rock'))).toBe('');
  });
});

describe('buildValueReport', () => {
  const bins = [
    bin('Toolbox', 'Garage', [item('Drill', { unit_price: 129 }), item('Tape')]),
    bin('Batteries', 'Garage', [item('AA', { unit_price: 0.5, quantity: 24 })]),
    bin('Misc', '', [item('String')]),
    bin('Linens', 'Attic', [item('Quilt', { unit_price: 80 })]),
    bin('Empty', 'Attic', []),
  ];

  it('totals by bin and area, areas A–Z with no-area last', () => {
    const r = buildValueReport(bins);
    expect(r.total).toBe(221);
    expect(r.itemCount).toBe(5);
    expect(r.pricedCount).toBe(3);
    expect(r.areas.map((a) => [a.name, a.total])).toEqual([['Attic', 80], ['Garage', 141], ['No area', 0]]);
    expect(r.areas[1].bins.map((b) => [b.name, b.total])).toEqual([['Batteries', 12], ['Toolbox', 129]]);
  });

  it('can drop unpriced items and the bins they leave empty', () => {
    const r = buildValueReport(bins, { pricedOnly: true });
    expect(r.areas.map((a) => a.name)).toEqual(['Attic', 'Garage']);
    expect(r.areas[1].bins.find((b) => b.name === 'Toolbox')?.items.map((i) => i.name)).toEqual(['Drill']);
    expect(r.itemCount).toBe(5);
  });

  it('exports a CSV row per item', () => {
    const csv = valueReportCsv(buildValueReport([
      bin('Toolbox', 'Garage', [item('Drill, cordless', { unit_price: 129, purchased_at: '2026-03-04T15:00:00.000Z', purchased_from: 'Home Depot', barcode: '885911425308' })]),
    ]));
    expect(csv).toBe(
      'Area,Bin,Item,Quantity,Unit Price,Total,Purchased,Store,Barcode\n'
      + 'Garage,Toolbox,"Drill, cordless",1,129.00,129.00,2026-03-04,Home Depot,885911425308\n',
    );
  });
});
