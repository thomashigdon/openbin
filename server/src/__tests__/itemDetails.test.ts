import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../index.js';
import { normalizeBarcode, parseItemDetails } from '../lib/itemDetails.js';
import { fetchProductImage, ProductImageError } from '../lib/stagedPurchaseImages.js';
import { createTestBin, createTestLocation, createTestUser } from './helpers.js';

vi.mock('../lib/stagedPurchaseImages.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/stagedPurchaseImages.js')>();
  return { ...orig, fetchProductImage: vi.fn() };
});

let app: Express;
let token: string;
let locationId: string;

beforeEach(async () => {
  app = createApp();
  token = (await createTestUser(app)).token;
  locationId = (await createTestLocation(app, token)).id;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

async function binWithItem(name = 'Cordless Drill') {
  const bin = await createTestBin(app, token, locationId, { name: 'Tools', items: [name] });
  const res = await request(app).get(`/api/bins/${bin.id}`).set(auth());
  return { bin, item: res.body.items[0] as { id: string } };
}

describe('parseItemDetails', () => {
  it('normalizes prices, dates, stores and barcodes', () => {
    expect(parseItemDetails({ unit_price: '$19.999', purchased_at: '2026-03-04', purchased_from: '  Home Depot ', barcode: '0 12345-67890 5' }))
      .toEqual({ unit_price: 20, purchased_at: '2026-03-04', purchased_from: 'Home Depot', barcode: '012345678905' });
  });

  it('treats empty values as clearing the field and leaves absent ones alone', () => {
    expect(parseItemDetails({ unit_price: '', barcode: null })).toEqual({ unit_price: null, barcode: null });
    expect(parseItemDetails({})).toEqual({});
  });

  it('rejects bad values', () => {
    expect(() => parseItemDetails({ unit_price: -1 })).toThrow(/unit_price/);
    expect(() => parseItemDetails({ purchased_at: 'last tuesday' })).toThrow(/purchased_at/);
    expect(() => parseItemDetails({ barcode: 'ABC123' })).toThrow(/barcode/);
  });

  it('only accepts 8–14 digit codes as barcodes', () => {
    expect(normalizeBarcode('12345678')).toBe('12345678');
    expect(normalizeBarcode('1234567')).toBeNull();
    expect(normalizeBarcode('openbin://bin/ABCDEF')).toBeNull();
  });
});

describe('PATCH /api/bins/:id/items/:itemId/details', () => {
  it('sets only the given fields and returns the item', async () => {
    const { bin, item } = await binWithItem();
    const res = await request(app).patch(`/api/bins/${bin.id}/items/${item.id}/details`).set(auth())
      .send({ unit_price: 129, purchased_from: 'Home Depot' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: item.id, name: 'Cordless Drill', unit_price: 129, purchased_from: 'Home Depot', purchased_at: null });

    await request(app).patch(`/api/bins/${bin.id}/items/${item.id}/details`).set(auth()).send({ purchased_at: '2025-12-24' });
    const after = await request(app).get(`/api/bins/${bin.id}`).set(auth());
    expect(after.body.items[0]).toMatchObject({ unit_price: 129, purchased_from: 'Home Depot', purchased_at: '2025-12-24' });
  });

  it('logs the change in the bin activity', async () => {
    const { bin, item } = await binWithItem();
    await request(app).patch(`/api/bins/${bin.id}/items/${item.id}/details`).set(auth()).send({ unit_price: 50 });
    const activity = await request(app).get(`/api/locations/${locationId}/activity`).set(auth());
    const entry = activity.body.results.find((e: { changes?: Record<string, unknown> }) => e.changes?.item_details);
    expect(entry.changes.item_details).toEqual({ old: { name: 'Cordless Drill', unit_price: null }, new: { name: 'Cordless Drill', unit_price: 50 } });
  });

  it('requires at least one field and validates them', async () => {
    const { bin, item } = await binWithItem();
    const empty = await request(app).patch(`/api/bins/${bin.id}/items/${item.id}/details`).set(auth()).send({ name: 'x' });
    expect(empty.status).toBe(422);
    const bad = await request(app).patch(`/api/bins/${bin.id}/items/${item.id}/details`).set(auth()).send({ barcode: '12' });
    expect(bad.status).toBe(422);
  });

  it('404s for an item in another bin', async () => {
    const { item } = await binWithItem();
    const other = await createTestBin(app, token, locationId, { name: 'Other' });
    const res = await request(app).patch(`/api/bins/${other.id}/items/${item.id}/details`).set(auth()).send({ unit_price: 1 });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/bins/:id/items with details', () => {
  it('stores purchase details and barcode on new items', async () => {
    const bin = await createTestBin(app, token, locationId, { name: 'Pantry' });
    const res = await request(app).post(`/api/bins/${bin.id}/items`).set(auth())
      .send({ items: [{ name: 'Olive Oil', quantity: 2, unit_price: 8.5, barcode: '041244001234' }, 'Salt'] });
    expect(res.status).toBe(201);
    const after = await request(app).get(`/api/bins/${bin.id}`).set(auth());
    expect(after.body.items).toEqual([
      expect.objectContaining({ name: 'Olive Oil', quantity: 2, unit_price: 8.5, barcode: '041244001234' }),
      expect.objectContaining({ name: 'Salt', unit_price: null, barcode: null }),
    ]);
  });

  it('rejects the whole request when one item has a bad barcode', async () => {
    const bin = await createTestBin(app, token, locationId, { name: 'Pantry' });
    const res = await request(app).post(`/api/bins/${bin.id}/items`).set(auth())
      .send({ items: ['Salt', { name: 'Olive Oil', barcode: 'nope' }] });
    expect(res.status).toBe(422);
    const after = await request(app).get(`/api/bins/${bin.id}`).set(auth());
    expect(after.body.items).toHaveLength(0);
  });
});

describe('GET /api/barcodes/:code', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('finds items already tagged with the code without calling out', async () => {
    const bin = await createTestBin(app, token, locationId, { name: 'Pantry' });
    await request(app).post(`/api/bins/${bin.id}/items`).set(auth()).send({ items: [{ name: 'Olive Oil', barcode: '041244001234' }] });

    const res = await request(app).get(`/api/barcodes/041244001234?location_id=${locationId}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.matches).toEqual([expect.objectContaining({ name: 'Olive Oil', bin_id: bin.id, bin_name: 'Pantry' })]);
    expect(res.body.product).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names an unknown code from UPCitemdb and caches it', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { items: [{ title: 'DEWALT 20V Drill  Driver', brand: 'DEWALT', images: ['http://x/a.jpg', 'https://x/b.jpg'] }] }));
    const res = await request(app).get(`/api/barcodes/885911425308?location_id=${locationId}`).set(auth());
    expect(res.body).toEqual({
      code: '885911425308',
      matches: [],
      product: { name: 'DEWALT 20V Drill Driver', brand: 'DEWALT', image_url: 'https://x/b.jpg', source: 'upcitemdb' },
    });

    const again = await request(app).get(`/api/barcodes/885911425308?location_id=${locationId}`).set(auth());
    expect(again.body.product.name).toBe('DEWALT 20V Drill Driver');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Open Food Facts', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { items: [] }))
      .mockResolvedValueOnce(json(200, { status: 1, product: { product_name: 'Nutella', brands: 'Ferrero,Nutella' } }));
    const res = await request(app).get(`/api/barcodes/3017620422003?location_id=${locationId}`).set(auth());
    expect(res.body.product).toEqual({ name: 'Nutella', brand: 'Ferrero', image_url: null, source: 'openfoodfacts' });
  });

  it('does not cache a miss while a service is failing', async () => {
    fetchMock
      .mockResolvedValueOnce(json(429, {}))
      .mockResolvedValueOnce(json(404, { status: 0 }));
    const first = await request(app).get(`/api/barcodes/12345670?location_id=${locationId}`).set(auth());
    expect(first.body.product).toBeNull();

    fetchMock.mockResolvedValueOnce(json(200, { items: [{ title: 'Widget' }] }));
    const second = await request(app).get(`/api/barcodes/12345670?location_id=${locationId}`).set(auth());
    expect(second.body.product.name).toBe('Widget');
  });

  it('remembers a code nobody knows', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { code: 'INVALID_UPC' })).mockResolvedValueOnce(json(404, { status: 0 }));
    await request(app).get(`/api/barcodes/99999997?location_id=${locationId}`).set(auth());
    await request(app).get(`/api/barcodes/99999997?location_id=${locationId}`).set(auth());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects non-barcodes and non-members', async () => {
    expect((await request(app).get(`/api/barcodes/abc?location_id=${locationId}`).set(auth())).status).toBe(422);
    const other = await createTestUser(app);
    const res = await request(app).get(`/api/barcodes/12345670?location_id=${locationId}`).set({ Authorization: `Bearer ${other.token}` });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/barcodes/:code/image', () => {
  const fetchMock = vi.fn();
  const imageMock = vi.mocked(fetchProductImage);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  beforeEach(() => {
    fetchMock.mockReset();
    imageMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  async function lookUp(code: string, images: string[]) {
    fetchMock.mockResolvedValueOnce(json(200, { items: [{ title: 'Widget', images }] }));
    await request(app).get(`/api/barcodes/${code}?location_id=${locationId}`).set(auth());
  }

  it('fetches the product photo once and serves the stored copy', async () => {
    await lookUp('11111116', ['http://img.example.com/w.jpg']);
    imageMock.mockResolvedValue(Buffer.from('RIFF....WEBPfake'));

    const first = await request(app).get('/api/barcodes/11111116/image').set(auth());
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('image/webp');
    // http listings are asked for over https
    expect(imageMock).toHaveBeenCalledWith('https://img.example.com/w.jpg');

    const second = await request(app).get('/api/barcodes/11111116/image').set(auth());
    expect(second.status).toBe(200);
    expect(imageMock).toHaveBeenCalledTimes(1);
  });

  it('404s when there is no image or it cannot be fetched, without retrying right away', async () => {
    await lookUp('22222222', []);
    expect((await request(app).get('/api/barcodes/22222222/image').set(auth())).status).toBe(404);

    await lookUp('33333335', ['https://img.example.com/gone.jpg']);
    imageMock.mockRejectedValue(new ProductImageError('status 404'));
    expect((await request(app).get('/api/barcodes/33333335/image').set(auth())).status).toBe(404);
    expect((await request(app).get('/api/barcodes/33333335/image').set(auth())).status).toBe(404);
    expect(imageMock).toHaveBeenCalledTimes(1);
  });

  it('requires sign-in', async () => {
    expect((await request(app).get('/api/barcodes/11111116/image')).status).toBe(401);
  });
});

describe('items list', () => {
  it('returns purchase details and matches a barcode search', async () => {
    const bin = await createTestBin(app, token, locationId, { name: 'Pantry' });
    await request(app).post(`/api/bins/${bin.id}/items`).set(auth())
      .send({ items: [{ name: 'Olive Oil', unit_price: 8.5, barcode: '041244001234' }, 'Salt'] });
    const res = await request(app).get(`/api/items?location_id=${locationId}&q=041244001234`).set(auth());
    expect(res.body.results).toEqual([expect.objectContaining({ name: 'Olive Oil', unit_price: 8.5, barcode: '041244001234' })]);
  });
});
