import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/stagedPurchaseAi.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/stagedPurchaseAi.js')>();
  return {
    ...orig,
    identifyPurchasePhoto: vi.fn(async () => ({ name: 'Gorilla Wood Glue 8 oz', quantity: 1, description: 'Yellow bottle' })),
  };
});

vi.mock('../lib/stagedPurchaseImages.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/stagedPurchaseImages.js')>();
  const { TEST_PNG } = await import('./helpers.js');
  return {
    ...orig,
    fetchProductImage: vi.fn(async (url: string) => {
      if (url.includes('broken')) throw new orig.ProductImageError('status 404');
      return TEST_PNG;
    }),
  };
});

const { createApp } = await import('../index.js');
const { createTestBin, createTestLocation, createTestUser, TEST_PNG } = await import('./helpers.js');
const ai = await import('../lib/stagedPurchaseAi.js');

let app: Express;
let token: string;
let locationId: string;

beforeEach(async () => {
  app = createApp();
  token = (await createTestUser(app)).token;
  locationId = (await createTestLocation(app, token)).id;
});

const auth = () => ({ Authorization: `Bearer ${token}` });

function amazon(asin: string, title: string, extra: Record<string, unknown> = {}) {
  return { source: 'amazon', external_id: `112-1-${asin}`, product_key: `amazon:${asin}`, store: 'Amazon', title, ...extra };
}

async function ingest(purchases: unknown[]) {
  return request(app).post(`/api/locations/${locationId}/staged-purchases`).set(auth()).send({ purchases });
}

async function pending() {
  const res = await request(app).get(`/api/locations/${locationId}/staged-purchases`).set(auth());
  expect(res.status).toBe(200);
  return res.body.results as Array<Record<string, any>>;
}

async function setUpBins() {
  const screws = await createTestBin(app, token, locationId, { name: 'Screws & Fasteners', items: ['Wood screws', 'Drywall anchors', 'Machine bolts'], tags: ['hardware'] });
  const kitchen = await createTestBin(app, token, locationId, { name: 'Kitchen Tools', items: ['Chef knife', 'Potato masher'] });
  const batteries = await createTestBin(app, token, locationId, { name: 'Batteries & Chargers', items: ['USB charger'] });
  return { screws, kitchen, batteries };
}

describe('ingest', () => {
  it('creates purchases, shortens long titles, and is idempotent per source + external_id', async () => {
    const title = 'DIVANC 550Pcs 304 Stainless Steel Wood Screws Assortment Kit, Phillips Pan Head Sheet Metal Screw Self Tapping Screws Set';
    let res = await ingest([amazon('B0SCREWS1', title, { delivered: false, price: 27.61 })]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: 1, updated: 0 });

    let list = await pending();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'DIVANC 550Pcs 304 Stainless Steel Wood Screws Assortment Kit', title, delivered: false, price: 27.61, store: 'Amazon' });

    // Re-sent by the next sync after delivery.
    res = await ingest([amazon('B0SCREWS1', title, { delivered: true })]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 0, updated: 1 });
    list = await pending();
    expect(list).toHaveLength(1);
    expect(list[0].delivered).toBe(true);

    res = await ingest([amazon('B0SCREWS1', title, { delivered: true })]);
    expect(res.body).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  it('skips cancelled orders', async () => {
    await ingest([amazon('B0CANCEL1', 'Some Gadget, Black')]);
    await ingest([amazon('B0CANCEL1', 'Some Gadget, Black', { cancelled: true })]);
    expect(await pending()).toHaveLength(0);
    const skipped = await request(app).get(`/api/locations/${locationId}/staged-purchases?status=skipped`).set(auth());
    expect(skipped.body.results[0].skip_reason).toBe('cancelled');
  });

  it('validates input', async () => {
    expect((await ingest([])).status).toBe(422);
    expect((await ingest([{ source: 'Amazon Store!', title: 'x' }])).status).toBe(422);
    expect((await ingest([{ source: 'amazon' }])).status).toBe(422);
    expect((await ingest([{ source: 'amazon', title: 'x', image_url: 'javascript:alert(1)' }])).status).toBe(422);
  });

  it('is not visible to non-members', async () => {
    await ingest([amazon('B0PRIVATE', 'Private Thing, Large')]);
    const other = await createTestUser(app);
    const res = await request(app).get(`/api/locations/${locationId}/staged-purchases`).set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(403);
    const post = await request(app).post(`/api/locations/${locationId}/staged-purchases`).set('Authorization', `Bearer ${other.token}`)
      .send({ purchases: [{ source: 'x', title: 'y' }] });
    expect(post.status).toBe(403);
  });
});

describe('suggestions', () => {
  it('suggests bins whose name, tags or items share words with the purchase', async () => {
    const { screws, kitchen } = await setUpBins();
    await ingest([
      amazon('B0SCREWS1', 'DIVANC 550Pcs 304 Stainless Steel Wood Screws Assortment Kit, Phillips Pan Head'),
      amazon('B0KNIFE01', 'Victorinox Fibrox Pro 8 Inch Chef’s Knife, Dishwasher Safe, Black'),
    ]);
    const list = await pending();
    const byAsin = (a: string) => list.find((p) => p.title.includes(a))!;
    const screwsSuggestion = byAsin('DIVANC').suggestions[0];
    expect(screwsSuggestion).toMatchObject({ bin_id: screws.id, reason: 'match' });
    expect(screwsSuggestion.detail).toContain('screw');
    expect(byAsin('Victorinox').suggestions[0]).toMatchObject({ bin_id: kitchen.id, reason: 'match' });
  });

  it('puts the bin you used last time first', async () => {
    const { kitchen, batteries } = await setUpBins();
    await ingest([amazon('B0BATT001', 'Duracell Coppertop AA Batteries, 24 Count')]);
    const [first] = await pending();
    // Batteries obviously match the batteries bin, but you filed them in the kitchen drawer.
    expect(first.suggestions[0].bin_id).toBe(batteries.id);
    const sort = await request(app).post(`/api/staged-purchases/${first.id}/sort`).set(auth()).send({ binId: kitchen.id });
    expect(sort.status).toBe(200);

    await ingest([{ ...amazon('B0BATT001', 'Duracell Coppertop AA Batteries, 24 Count'), external_id: '113-2-B0BATT001' }]);
    const [again] = await pending();
    expect(again.suggestions[0]).toMatchObject({ bin_id: kitchen.id, reason: 'history' });
  });

  it('suggests where the rest of the order went', async () => {
    const { screws } = await setUpBins();
    await ingest([
      { ...amazon('B0STAND01', '580 PCS M3 Nylon Standoff Kit'), external_id: '112-7:B0STAND01', order_ref: '112-7' },
      { ...amazon('B0OLED001', 'ELEGOO 0.96 Inch OLED Display Module'), external_id: '112-7:B0OLED001', order_ref: '112-7' },
    ]);
    const list = await pending();
    const standoff = list.find((p) => p.title.includes('Standoff'))!;
    await request(app).post(`/api/staged-purchases/${standoff.id}/sort`).set(auth()).send({ binId: screws.id });
    const [oled] = await pending();
    expect(oled.suggestions[0]).toMatchObject({ bin_id: screws.id, reason: 'order', detail: 'Something else from this order is here' });
  });

  it('uses the shopping list origin bin', async () => {
    const { kitchen } = await setUpBins();
    const add = await request(app).post(`/api/bins/${kitchen.id}/shopping-list`).set(auth()).send({ names: ['Parchment paper'] });
    expect(add.status).toBe(201);
    await ingest([amazon('B0PARCH01', 'Reynolds Kitchens Parchment Paper Roll, 45 Square Feet')]);
    const [p] = await pending();
    expect(p.suggestions[0]).toMatchObject({ bin_id: kitchen.id, reason: 'shopping_list' });
  });
});

describe('sorting and skipping', () => {
  it('sort creates a bin item, records the bin, and clears it from the list', async () => {
    const { screws } = await setUpBins();
    await ingest([amazon('B0SCREWS1', 'DIVANC 550Pcs Wood Screws Assortment Kit, Phillips', { quantity: 2 })]);
    const [p] = await pending();

    const res = await request(app).post(`/api/staged-purchases/${p.id}/sort`).set(auth())
      .send({ binId: screws.id, name: 'Stainless wood screw kit' });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ bin_id: screws.id, name: 'Stainless wood screw kit', quantity: 2 });
    expect(res.body.purchase).toMatchObject({ status: 'sorted', sorted_bin_id: screws.id, sorted_bin_name: 'Screws & Fasteners' });

    const bin = await request(app).get(`/api/bins/${screws.id}`).set(auth());
    expect(bin.body.items.map((i: { name: string }) => i.name)).toContain('Stainless wood screw kit');
    expect(await pending()).toHaveLength(0);
    const count = await request(app).get(`/api/locations/${locationId}/staged-purchases/count`).set(auth());
    expect(count.body).toEqual({ pending: 0, awaiting_delivery: 0 });

    const again = await request(app).post(`/api/staged-purchases/${p.id}/sort`).set(auth()).send({ binId: screws.id });
    expect(again.status).toBe(409);
  });

  it('single items go in without a quantity', async () => {
    const { kitchen } = await setUpBins();
    await ingest([amazon('B0KNIFE01', 'Chef Knife 8 Inch', { quantity: 1 })]);
    const [p] = await pending();
    const res = await request(app).post(`/api/staged-purchases/${p.id}/sort`).set(auth()).send({ binId: kitchen.id });
    expect(res.body.item.quantity).toBeNull();
  });

  it('restore takes a sorted item back out of the bin', async () => {
    const { kitchen } = await setUpBins();
    await ingest([amazon('B0RICER01', 'Joseph Joseph Helix Potato Ricer')]);
    const [p] = await pending();
    await request(app).post(`/api/staged-purchases/${p.id}/sort`).set(auth()).send({ binId: kitchen.id });
    const res = await request(app).post(`/api/staged-purchases/${p.id}/restore`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.purchase.status).toBe('pending');
    const bin = await request(app).get(`/api/bins/${kitchen.id}`).set(auth());
    expect(bin.body.items.map((i: { name: string }) => i.name)).not.toContain('Joseph Joseph Helix Potato Ricer');
    expect(await pending()).toHaveLength(1);
  });

  it('skipping a product auto-skips it next time', async () => {
    await ingest([amazon('B0SODA001', 'Arm & Hammer Super Washing Soda, 55oz')]);
    const [p] = await pending();
    expect((await request(app).post(`/api/staged-purchases/${p.id}/skip`).set(auth())).status).toBe(200);

    const res = await ingest([{ ...amazon('B0SODA001', 'Arm & Hammer Super Washing Soda, 55oz'), external_id: '114-9-B0SODA001' }]);
    expect(res.body).toMatchObject({ created: 1, auto_skipped: 1 });
    expect(await pending()).toHaveLength(0);
  });

  it('bulk-sorts and bulk-skips', async () => {
    const { screws } = await setUpBins();
    await ingest([
      amazon('B0PART001', 'Resistor Kit 1/4W'),
      amazon('B0PART002', 'Breadboard Kit'),
      amazon('B0PART003', 'Toothpaste, Strawberry'),
    ]);
    const list = await pending();
    const ids = list.filter((p) => !p.title.includes('Toothpaste')).map((p) => p.id);
    const sorted = await request(app).post('/api/staged-purchases/bulk-sort').set(auth()).send({ ids, binId: screws.id });
    expect(sorted.body).toMatchObject({ sorted: 2, bin_name: 'Screws & Fasteners' });
    const rest = await pending();
    expect(rest).toHaveLength(1);
    const skipped = await request(app).post('/api/staged-purchases/bulk-skip').set(auth()).send({ ids: [rest[0].id] });
    expect(skipped.body.skipped).toBe(1);
    expect(await pending()).toHaveLength(0);
  });

  it("won't sort into a bin in another location", async () => {
    await ingest([amazon('B0X', 'Thing, Blue')]);
    const [p] = await pending();
    const otherLoc = await createTestLocation(app, token);
    const otherBin = await createTestBin(app, token, otherLoc.id, { name: 'Elsewhere' });
    const res = await request(app).post(`/api/staged-purchases/${p.id}/sort`).set(auth()).send({ binId: otherBin.id });
    expect(res.status).toBe(404);
  });
});

describe('in-store purchases by photo', () => {
  it('names the item with AI and suggests bins', async () => {
    await createTestBin(app, token, locationId, { name: 'Glue & Adhesives', items: ['Super glue', 'Wood glue'] });
    const res = await request(app).post(`/api/locations/${locationId}/staged-purchases/photo`).set(auth())
      .attach('photo', TEST_PNG, 'glue.png');
    expect(res.status).toBe(201);
    expect(res.body.purchase).toMatchObject({ name: 'Gorilla Wood Glue 8 oz', source: 'photo', store: 'In store', has_photo: true });
    expect(res.body.purchase.suggestions[0].bin_name).toBe('Glue & Adhesives');
    expect(ai.identifyPurchasePhoto).toHaveBeenCalledTimes(1);

    const photo = await request(app).get(`/api/staged-purchases/${res.body.purchase.id}/photo`).set(auth());
    expect(photo.status).toBe(200);
    expect(photo.headers['content-type']).toMatch(/^image\//);
  });

  it('uses a typed name without calling the AI', async () => {
    vi.mocked(ai.identifyPurchasePhoto).mockClear();
    const res = await request(app).post(`/api/locations/${locationId}/staged-purchases/photo`).set(auth())
      .field('name', 'Painter’s tape').attach('photo', TEST_PNG, 'tape.png');
    expect(res.status).toBe(201);
    expect(res.body.purchase.name).toBe('Painter’s tape');
    expect(ai.identifyPurchasePhoto).not.toHaveBeenCalled();
  });

  it('requires a photo', async () => {
    const res = await request(app).post(`/api/locations/${locationId}/staged-purchases/photo`).set(auth()).field('name', 'x');
    expect(res.status).toBe(422);
  });

  it('deleting removes it and its photo', async () => {
    const res = await request(app).post(`/api/locations/${locationId}/staged-purchases/photo`).set(auth())
      .field('name', 'Mistake').attach('photo', TEST_PNG, 'x.png');
    const id = res.body.purchase.id;
    expect((await request(app).delete(`/api/staged-purchases/${id}`).set(auth())).status).toBe(200);
    expect((await request(app).get(`/api/staged-purchases/${id}/photo`).set(auth())).status).toBe(404);
  });
});

describe('store product photos', () => {
  it('fetches the listing image once and serves it from storage', async () => {
    const images = await import('../lib/stagedPurchaseImages.js');
    vi.mocked(images.fetchProductImage).mockClear();
    await ingest([amazon('B0IMG0001', 'Thing With Photo', { image_url: 'https://m.media-amazon.com/images/I/abc.jpg' })]);
    const [p] = await pending();
    expect(p.has_photo).toBe(true);
    for (let i = 0; i < 2; i++) {
      const res = await request(app).get(`/api/staged-purchases/${p.id}/photo`).set(auth());
      expect(res.status).toBe(200);
    }
    expect(images.fetchProductImage).toHaveBeenCalledTimes(1);
  });

  it('a dead image link is a 404, and is not retried right away', async () => {
    const images = await import('../lib/stagedPurchaseImages.js');
    vi.mocked(images.fetchProductImage).mockClear();
    await ingest([amazon('B0IMG0002', 'Thing With Dead Photo', { image_url: 'https://example.com/broken.jpg' })]);
    const [p] = await pending();
    expect((await request(app).get(`/api/staged-purchases/${p.id}/photo`).set(auth())).status).toBe(404);
    expect((await request(app).get(`/api/staged-purchases/${p.id}/photo`).set(auth())).status).toBe(404);
    expect(images.fetchProductImage).toHaveBeenCalledTimes(1);
  });

  it('photos are only visible to members of the location', async () => {
    await ingest([amazon('B0IMG0003', 'Private Photo', { image_url: 'https://m.media-amazon.com/images/I/def.jpg' })]);
    const [p] = await pending();
    const other = await createTestUser(app);
    const res = await request(app).get(`/api/staged-purchases/${p.id}/photo`).set('Authorization', `Bearer ${other.token}`);
    expect(res.status).toBe(404);
  });
});
