import { describe, expect, it } from 'vitest';
import { buildSuggester, parseStagedInput, shortenTitle } from '../stagedPurchases.js';

describe('shortenTitle', () => {
  it('cuts listing titles at the first separator after a few words', () => {
    expect(shortenTitle('Victorinox Fibrox Pro 8 Inch Chef’s Knife, Dishwasher Safe, Black | Ergonomic handle'))
      .toBe('Victorinox Fibrox Pro 8 Inch Chef’s Knife');
    expect(shortenTitle('Joseph Joseph Helix Ergonomic Twist-Action Potato Ricer & Masher')).toBe('Joseph Joseph Helix Ergonomic Twist-Action Potato Ricer & Masher');
  });

  it('keeps short leading segments together', () => {
    expect(shortenTitle('AA, Batteries, 24 Count')).toBe('AA, Batteries, 24 Count');
  });

  it('caps very long titles at a word boundary', () => {
    const s = shortenTitle('UGREEN 240W Right Angle USB C Cable PD 3.1 Fast Charging 6.6ft For iPhone 18 17 16 15 MacBook Pro M5 iPad Galaxy S26 S25 Steam Deck Switch');
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s.startsWith('UGREEN 240W Right Angle USB C Cable')).toBe(true);
    expect(s.endsWith(' ')).toBe(false);
  });
});

describe('parseStagedInput', () => {
  it('fills name and product key', () => {
    const p = parseStagedInput({ source: 'amazon', title: 'Gorilla Wood Glue, 8 oz, Yellow', external_id: 'o1#0' });
    expect(p.name).toBe('Gorilla Wood Glue');
    expect(p.productKey).toBe('amazon:gorilla wood glue 8 oz yellow');
    expect(p.delivered).toBe(true);
  });
});

describe('buildSuggester', () => {
  const bins = [
    { id: 'screws', name: 'Screws & Fasteners', area_name: 'Garage', icon: '', color: '', tags: ['hardware'], items: ['Wood screws', 'Drywall anchors'] },
    { id: 'kitchen', name: 'Kitchen Tools', area_name: 'Kitchen', icon: '', color: '', tags: [], items: ['Chef knife', 'Potato masher'] },
    { id: 'elec', name: 'Electronics Parts', area_name: 'Garage', icon: '', color: '', tags: ['electronics'], items: ['Resistors', 'Breadboards', 'Jumper wires'] },
  ];

  it('ranks by shared words, weighting bin names above items above area', () => {
    const suggest = buildSuggester({ bins, history: new Map(), shoppingList: [] });
    const s = suggest({ name: 'BOJACK Resistor Kit', title: 'BOJACK 50 Values 1350 Pcs Resistor Kit 0 Ohm-5.6M Ohm', product_key: null });
    expect(s[0].bin_id).toBe('elec');
    expect(s[0].detail).toContain('“resistor”');
  });

  it('returns nothing when no bin shares a meaningful word', () => {
    const suggest = buildSuggester({ bins, history: new Map(), shoppingList: [] });
    expect(suggest({ name: 'Lonely Planet Kids Atlas', title: 'Lonely Planet Kids My First Lift-the-Flap World Atlas', product_key: null })).toEqual([]);
  });

  it('ignores listing filler like "pack" and "pcs"', () => {
    const suggest = buildSuggester({
      bins: [...bins, { id: 'packs', name: 'Packs and Pieces', area_name: '', icon: '', color: '', tags: [], items: [] }],
      history: new Map(),
      shoppingList: [],
    });
    const s = suggest({ name: 'Tea Lights 24 Pack', title: 'Tea Lights 24 Pack, 50 pcs', product_key: null });
    expect(s.find((x) => x.bin_id === 'packs')).toBeUndefined();
  });

  it('counts part-word matches, less than whole words', () => {
    const suggest = buildSuggester({ bins, history: new Map(), shoppingList: [] });
    // "board" only appears inside "breadboards"
    const s = suggest({ name: 'Mini Development Board', title: 'ESP32 Mini Development Board', product_key: null });
    expect(s[0]?.bin_id).toBe('elec');
    expect(s[0].confident).toBe(false);
  });

  it('a single shared item word is shown but not marked confident; two words or a bin-name match are', () => {
    const suggest = buildSuggester({ bins, history: new Map(), shoppingList: [] });
    const one = suggest({ name: 'Gorilla Wood Glue', title: 'Gorilla Wood Glue 8 oz', product_key: null });
    expect(one[0]).toMatchObject({ bin_id: 'screws', confident: false });
    const two = suggest({ name: 'Wood Screws', title: 'Wood Screws', product_key: null });
    expect(two[0]).toMatchObject({ bin_id: 'screws', confident: true });
    const name = suggest({ name: 'Kitchen Scale', title: 'Kitchen Scale', product_key: null });
    expect(name[0]).toMatchObject({ bin_id: 'kitchen', confident: true });
  });

  it('things from the same order go together', () => {
    const suggest = buildSuggester({
      bins, history: new Map(), shoppingList: [],
      orderSiblings: new Map([['amazon|112-1', new Map([['elec', 2]])]]),
    });
    const s = suggest({ name: 'OLED Display Module', title: 'OLED Display Module', product_key: null, order_key: 'amazon|112-1' });
    expect(s[0]).toMatchObject({ bin_id: 'elec', reason: 'order', detail: '2 other things from this order are here', confident: true });
  });

  it('history beats word matches, and skips bins that no longer exist', () => {
    const history = new Map([['amazon:B1', new Map([['kitchen', 2], ['gone', 5]])]]);
    const suggest = buildSuggester({ bins, history, shoppingList: [] });
    const s = suggest({ name: 'Wood Screws', title: 'Wood Screws', product_key: 'amazon:B1' });
    expect(s[0]).toMatchObject({ bin_id: 'kitchen', reason: 'history', detail: 'You put this here 2 times before' });
    expect(s[1].bin_id).toBe('screws');
    expect(s.some((x) => x.bin_id === 'gone')).toBe(false);
  });
});
