/**
 * "To be sorted": purchases waiting to be put into a bin.
 *
 * Location-scoped (mounted at /api/locations):
 *   GET  /:locationId/staged-purchases?status=pending|sorted|skipped  list (pending ones carry bin suggestions)
 *   GET  /:locationId/staged-purchases/count                          { pending, awaiting_delivery }
 *   POST /:locationId/staged-purchases                                ingest from any store (idempotent per source+external_id)
 *   POST /:locationId/staged-purchases/photo                          in-store purchase: photo → AI names it (or pass `name`)
 *
 * Entry-level (mounted at /api/staged-purchases):
 *   POST /:id/sort { binId, name?, quantity? }   put it in a bin (creates a normal bin item)
 *   POST /bulk-sort { ids, binId }
 *   POST /:id/skip, POST /bulk-skip { ids }        not storing this (skipping teaches auto-skip for the same product)
 *   POST /:id/restore                              undo sort/skip
 *   GET  /:id/photo, DELETE /:id
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import type { TxQueryFn } from '../db/types.js';
import { generateUuid, query, withTransaction } from '../db.js';
import { visionWeight } from '../lib/aiCreditWeights.js';
import { resizeImageForAi } from '../lib/aiImageResize.js';
import { aiRouteHandler } from '../lib/aiRouteHandler.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { isLocationAdmin, requireMemberOrAbove, verifyBinAccess, verifyLocationMembership } from '../lib/binAccess.js';
import { config, isDemoUser } from '../lib/config.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../lib/httpErrors.js';
import { createLogger } from '../lib/logger.js';
import { aiRateLimiters } from '../lib/rateLimiters.js';
import { logRouteActivity } from '../lib/routeHelpers.js';
import { identifyPurchasePhoto } from '../lib/stagedPurchaseAi.js';
import { fetchProductImage, PRODUCT_IMAGE_EXT, ProductImageError } from '../lib/stagedPurchaseImages.js';
import {
  type BinSuggestion,
  buildSuggester,
  defaultProductKey,
  MAX_NAME_LEN,
  parseStagedBatch,
  parseStagedInput,
  type StagedPurchaseInput,
  type SuggestableBin,
} from '../lib/stagedPurchases.js';
import { storage } from '../lib/storage.js';
import { MIME_TO_EXT, memoryPhotoUpload, validateFileBuffer } from '../lib/uploadConfig.js';
import { stripUnicodeControl } from '../lib/validation.js';
import { authenticate } from '../middleware/auth.js';
import { requireLocationMember } from '../middleware/locationAccess.js';
import { checkAiCredits, requireAiAccess } from '../middleware/requirePlan.js';

type Q = TxQueryFn;

const log = createLogger('staged-purchases');

interface StagedRow {
  id: string;
  location_id: string;
  source: string;
  external_id: string | null;
  product_key: string | null;
  store: string;
  order_ref: string;
  title: string;
  name: string;
  quantity: number | null;
  price: number | null;
  currency: string | null;
  purchased_at: string | null;
  product_url: string | null;
  image_url: string | null;
  photo_key: string | null;
  delivered: number | boolean;
  status: 'pending' | 'sorted' | 'skipped';
  skip_reason: string | null;
  sorted_bin_id: string | null;
  sorted_item_id: string | null;
  resolved_at: string | null;
  created_at: string;
  sorted_bin_name?: string | null;
}

function toApi(r: StagedRow, suggestions: BinSuggestion[] = []) {
  return {
    id: r.id,
    location_id: r.location_id,
    source: r.source,
    store: r.store,
    order_ref: r.order_ref,
    title: r.title,
    name: r.name,
    quantity: r.quantity === null ? null : Number(r.quantity),
    price: r.price === null ? null : Number(r.price),
    currency: r.currency,
    purchased_at: r.purchased_at,
    product_url: r.product_url,
    image_url: r.image_url,
    has_photo: !!r.photo_key || !!r.image_url,
    delivered: Number(r.delivered) === 1 || r.delivered === true,
    status: r.status,
    skip_reason: r.skip_reason,
    sorted_bin_id: r.sorted_bin_id,
    sorted_bin_name: r.sorted_bin_name ?? null,
    resolved_at: r.resolved_at,
    created_at: r.created_at,
    suggestions,
  };
}

const SELECT_STAGED = `SELECT sp.*, b.name AS sorted_bin_name
  FROM staged_purchases sp LEFT JOIN bins b ON b.id = sp.sorted_bin_id`;

async function loadStaged(id: string): Promise<StagedRow> {
  const r = await query<StagedRow>(`${SELECT_STAGED} WHERE sp.id = $1`, [id]);
  if (r.rows.length === 0) throw new NotFoundError('Purchase not found');
  return r.rows[0];
}

/** Load the entry and check the caller may change it. */
async function loadForWrite(id: string, userId: string, action: string): Promise<StagedRow> {
  const row = await loadStaged(id);
  if (!(await verifyLocationMembership(row.location_id, userId))) throw new NotFoundError('Purchase not found');
  await requireMemberOrAbove(row.location_id, userId, action);
  return row;
}

function parseIds(raw: unknown, max = 100): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ValidationError('ids must be a non-empty array');
  if (raw.length > max) throw new ValidationError(`ids must contain at most ${max} entries`);
  if (!raw.every((x) => typeof x === 'string' && x.length <= 64)) throw new ValidationError('ids must be strings');
  return [...new Set(raw as string[])];
}

// ── Suggestions ──────────────────────────────────────────────────────

async function suggesterFor(locationId: string, userId: string) {
  const [binRows, itemRows, historyRows, siblingRows, shoppingRows, admin] = await Promise.all([
    query<{ id: string; name: string; area_name: string; icon: string; color: string; tags: string | string[]; created_by: string | null }>(
      `SELECT b.id, b.name, COALESCE(a.name, '') AS area_name, b.icon, b.color, b.tags, b.created_by
       FROM bins b LEFT JOIN areas a ON a.id = b.area_id
       WHERE b.location_id = $1 AND b.deleted_at IS NULL
         AND (b.visibility = 'location' OR b.created_by = $2)`,
      [locationId, userId],
    ),
    query<{ bin_id: string; name: string }>(
      `SELECT bi.bin_id, bi.name FROM bin_items bi JOIN bins b ON b.id = bi.bin_id
       WHERE b.location_id = $1 AND b.deleted_at IS NULL AND bi.deleted_at IS NULL`,
      [locationId],
    ),
    query<{ product_key: string; sorted_bin_id: string; n: number | string }>(
      `SELECT product_key, sorted_bin_id, COUNT(*) AS n FROM staged_purchases
       WHERE location_id = $1 AND status = 'sorted' AND product_key IS NOT NULL AND sorted_bin_id IS NOT NULL
       GROUP BY product_key, sorted_bin_id`,
      [locationId],
    ),
    query<{ source: string; order_ref: string; sorted_bin_id: string; n: number | string }>(
      `SELECT source, order_ref, sorted_bin_id, COUNT(*) AS n FROM staged_purchases
       WHERE location_id = $1 AND status = 'sorted' AND order_ref <> '' AND sorted_bin_id IS NOT NULL
       GROUP BY source, order_ref, sorted_bin_id`,
      [locationId],
    ),
    query<{ name: string; origin_bin_id: string | null }>(
      'SELECT name, origin_bin_id FROM shopping_list_items WHERE location_id = $1',
      [locationId],
    ),
    isLocationAdmin(locationId, userId),
  ]);

  const items = new Map<string, string[]>();
  for (const r of itemRows.rows) {
    const list = items.get(r.bin_id) ?? [];
    list.push(r.name);
    items.set(r.bin_id, list);
  }
  // Same rule as adding items to a bin: only the bin's creator or a location admin.
  const bins: SuggestableBin[] = binRows.rows
    .filter((b) => admin || b.created_by === userId)
    .map((b) => {
      let tags: unknown = b.tags;
      if (typeof tags === 'string') {
        try { tags = JSON.parse(tags); } catch { tags = []; }
      }
      return {
        id: b.id,
        name: b.name,
        area_name: b.area_name ?? '',
        icon: b.icon ?? '',
        color: b.color ?? '',
        tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
        items: items.get(b.id) ?? [],
      };
    });

  const history = new Map<string, Map<string, number>>();
  for (const h of historyRows.rows) {
    const m = history.get(h.product_key) ?? new Map<string, number>();
    m.set(h.sorted_bin_id, Number(h.n));
    history.set(h.product_key, m);
  }

  const orderSiblings = new Map<string, Map<string, number>>();
  for (const r of siblingRows.rows) {
    const key = orderKey(r.source, r.order_ref);
    const m = orderSiblings.get(key) ?? new Map<string, number>();
    m.set(r.sorted_bin_id, Number(r.n));
    orderSiblings.set(key, m);
  }

  return buildSuggester({ bins, history, orderSiblings, shoppingList: shoppingRows.rows });
}

function orderKey(source: string, orderRef: string): string {
  return `${source}|${orderRef}`;
}

function suggestionInput(r: StagedRow) {
  return { name: r.name, title: r.title, product_key: r.product_key, order_key: r.order_ref ? orderKey(r.source, r.order_ref) : null };
}

// ── Ingest ───────────────────────────────────────────────────────────

interface IngestStats {
  created: number;
  updated: number;
  unchanged: number;
  auto_skipped: number;
  ids: string[];
}

async function insertStaged(
  q: Q,
  locationId: string,
  userId: string,
  p: StagedPurchaseInput & { photoKey?: string | null },
): Promise<{ id: string; autoSkipped: boolean }> {
  let status: 'pending' | 'skipped' = 'pending';
  let skipReason: string | null = null;
  if (p.cancelled) {
    status = 'skipped';
    skipReason = 'cancelled';
  } else if (p.productKey) {
    // Learned: you skipped this exact product before, so don't ask again.
    const prev = await q(
      `SELECT 1 FROM staged_purchases WHERE location_id = $1 AND product_key = $2
       AND status = 'skipped' AND skip_reason = 'user' LIMIT 1`,
      [locationId, p.productKey],
    );
    if (prev.rows.length > 0) {
      status = 'skipped';
      skipReason = 'auto';
    }
  }
  const id = generateUuid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO staged_purchases (id, location_id, source, external_id, product_key, store, order_ref, title, name,
       quantity, price, currency, purchased_at, product_url, image_url, photo_key, delivered, status, skip_reason,
       resolved_at, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $22)`,
    [id, locationId, p.source, p.externalId, p.productKey, p.store, p.orderRef, p.title, p.name,
      p.quantity, p.price, p.currency, p.purchasedAt, p.productUrl, p.imageUrl, p.photoKey ?? null,
      p.delivered ? 1 : 0, status, skipReason, status === 'skipped' ? now : null, userId, now],
  );
  return { id, autoSkipped: skipReason === 'auto' };
}

export async function ingestPurchases(locationId: string, userId: string, inputs: StagedPurchaseInput[]): Promise<IngestStats> {
  return withTransaction(async (q) => {
    const stats: IngestStats = { created: 0, updated: 0, unchanged: 0, auto_skipped: 0, ids: [] };
    for (const p of inputs) {
      const existing = p.externalId
        ? (await q<StagedRow>(
          'SELECT * FROM staged_purchases WHERE location_id = $1 AND source = $2 AND external_id = $3',
          [locationId, p.source, p.externalId],
        )).rows[0]
        : undefined;

      if (!existing) {
        const { id, autoSkipped } = await insertStaged(q, locationId, userId, p);
        stats.created++;
        if (autoSkipped) stats.auto_skipped++;
        stats.ids.push(id);
        continue;
      }

      // Re-sent by a feeder: refresh what may have changed, never reopen something already handled.
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
      const delivered = Number(existing.delivered) === 1 || existing.delivered === true;
      if (p.delivered !== delivered) set('delivered', p.delivered ? 1 : 0);
      if (!existing.image_url && p.imageUrl) set('image_url', p.imageUrl);
      if (existing.price === null && p.price !== null) set('price', p.price);
      if (existing.quantity === null && p.quantity !== null) set('quantity', p.quantity);
      if (!existing.purchased_at && p.purchasedAt) set('purchased_at', p.purchasedAt);
      if (!existing.product_url && p.productUrl) set('product_url', p.productUrl);
      if (p.cancelled && existing.status === 'pending') {
        set('status', 'skipped');
        set('skip_reason', 'cancelled');
        set('resolved_at', new Date().toISOString());
      }
      stats.ids.push(existing.id);
      if (sets.length === 0) {
        stats.unchanged++;
        continue;
      }
      set('updated_at', new Date().toISOString());
      params.push(existing.id);
      await q(`UPDATE staged_purchases SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      stats.updated++;
    }
    return stats;
  });
}

// ── Sorting ──────────────────────────────────────────────────────────

async function binForSorting(binId: unknown, locationId: string, userId: string) {
  if (typeof binId !== 'string' || !binId) throw new ValidationError('binId is required');
  const access = await verifyBinAccess(binId, userId);
  if (!access || access.locationId !== locationId) throw new NotFoundError('Bin not found');
  if (access.createdBy !== userId && !(await isLocationAdmin(locationId, userId))) {
    throw new ForbiddenError('Only the bin creator or a location admin can add items to this bin');
  }
  return { id: binId, name: access.name as string };
}

async function sortInto(q: TxQueryFn, row: StagedRow, binId: string, userId: string, name: string, quantity: number | null) {
  const pos = await q<{ max_pos: number | null }>(
    'SELECT MAX(position) AS max_pos FROM bin_items WHERE bin_id = $1 AND deleted_at IS NULL',
    [binId],
  );
  const itemId = generateUuid();
  const now = new Date().toISOString();
  await q(
    `INSERT INTO bin_items (id, bin_id, name, quantity, position, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [itemId, binId, name, quantity, (pos.rows[0]?.max_pos ?? -1) + 1, now],
  );
  await q('UPDATE bins SET updated_at = $1 WHERE id = $2', [now, binId]);
  await q(
    `UPDATE staged_purchases SET status = 'sorted', skip_reason = NULL, sorted_bin_id = $1, sorted_item_id = $2,
       name = $3, resolved_by = $4, resolved_at = $5, updated_at = $5 WHERE id = $6`,
    [binId, itemId, name, userId, now, row.id],
  );
  return itemId;
}

/** Bin items keep a quantity only when it says something (a single item is just the item). */
function itemQuantity(q: number | null): number | null {
  return q !== null && q > 1 ? q : null;
}

function parseName(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') throw new ValidationError('name must be a string');
  const s = stripUnicodeControl(raw.trim());
  if (!s) return fallback;
  if (s.length > MAX_NAME_LEN) throw new ValidationError(`name too long (max ${MAX_NAME_LEN})`);
  return s;
}

function parseQuantity(raw: unknown, fallback: number | null): number | null {
  if (raw === undefined) return fallback;
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) throw new ValidationError('quantity must be a positive number');
  return Math.floor(raw);
}

/** Run middlewares only when `pred` holds (e.g. AI gating only when the AI will actually be called). */
function onlyWhen(pred: (req: Request) => boolean, ...mws: RequestHandler[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!pred(req)) { next(); return; }
    let i = 0;
    const step = (err?: unknown) => {
      if (err) { next(err); return; }
      const mw = mws[i++];
      if (!mw) { next(); return; }
      try {
        mw(req, res, step);
      } catch (e) {
        next(e);
      }
    };
    step();
  };
}

// ════════════════════════════════════════════════════════════════════
// Location-scoped router (mounted at /api/locations)
// ════════════════════════════════════════════════════════════════════

export const locationStagedRouter = Router();
locationStagedRouter.use(authenticate);

locationStagedRouter.get('/:locationId/staged-purchases/count', requireLocationMember('locationId'), asyncHandler(async (req, res) => {
  const r = await query<{ delivered: number; n: number | string }>(
    `SELECT delivered, COUNT(*) AS n FROM staged_purchases
     WHERE location_id = $1 AND status = 'pending' GROUP BY delivered`,
    [req.params.locationId],
  );
  let pending = 0;
  let awaiting = 0;
  for (const row of r.rows) {
    pending += Number(row.n);
    if (Number(row.delivered) !== 1) awaiting += Number(row.n);
  }
  res.json({ pending, awaiting_delivery: awaiting });
}));

locationStagedRouter.get('/:locationId/staged-purchases', requireLocationMember('locationId'), asyncHandler(async (req, res) => {
  const { locationId } = req.params;
  const status = typeof req.query.status === 'string' ? req.query.status : 'pending';
  if (!['pending', 'sorted', 'skipped'].includes(status)) throw new ValidationError('status must be pending, sorted or skipped');

  const rows = await query<StagedRow>(
    `${SELECT_STAGED} WHERE sp.location_id = $1 AND sp.status = $2
     ORDER BY ${status === 'pending' ? 'sp.delivered DESC, COALESCE(sp.purchased_at, sp.created_at) DESC,' : 'sp.resolved_at DESC,'} sp.created_at DESC
     LIMIT ${status === 'pending' ? 500 : 200}`,
    [locationId, status],
  );

  let suggest: ((r: StagedRow) => BinSuggestion[]) | null = null;
  if (status === 'pending' && rows.rows.length > 0) {
    const s = await suggesterFor(locationId, req.user!.id);
    suggest = (r) => s(suggestionInput(r));
  }
  const results = rows.rows.map((r) => toApi(r, suggest ? suggest(r) : []));
  res.json({ results, count: results.length });
}));

// Ingest from any store. Idempotent: re-sending the same source + external_id updates delivery status etc.
locationStagedRouter.post('/:locationId/staged-purchases', requireLocationMember('locationId'), asyncHandler(async (req, res) => {
  const { locationId } = req.params;
  await requireMemberOrAbove(locationId, req.user!.id, 'add purchases');
  const inputs = parseStagedBatch(req.body);
  const stats = await ingestPurchases(locationId, req.user!.id, inputs);
  res.status(stats.created > 0 ? 201 : 200).json(stats);
}));

// In-store purchase: photograph it, the AI names it. Pass `name` to skip the AI.
locationStagedRouter.post(
  '/:locationId/staged-purchases/photo',
  requireLocationMember('locationId'),
  memoryPhotoUpload.single('photo'),
  onlyWhen((req) => !(typeof req.body?.name === 'string' && req.body.name.trim()),
    ...aiRateLimiters, requireAiAccess(), checkAiCredits(visionWeight(1))),
  aiRouteHandler('identify purchase photo', async (req, res) => {
    const { locationId } = req.params;
    const userId = req.user!.id;
    await requireMemberOrAbove(locationId, userId, 'add purchases');
    const file = req.file;
    if (!file) throw new ValidationError('photo is required');
    await validateFileBuffer(file.buffer);

    const image = await resizeImageForAi(file.buffer, file.mimetype);
    const typedName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    let name = typedName;
    let quantity: number | null = null;
    let description: string | null = null;
    if (!name) {
      if (config.aiMock) {
        name = 'Mock Identified Item';
      } else {
        const ai = await identifyPurchasePhoto(userId, image, isDemoUser(req));
        ({ name, quantity, description } = ai);
      }
    }

    const id = generateUuid();
    const photoKey = `staged/${locationId}/${id}${MIME_TO_EXT[image.mimeType] ?? '.jpg'}`;
    await storage.upload(photoKey, image.buffer, image.mimeType);

    const input = parseStagedInput({
      source: 'photo',
      store: typeof req.body?.store === 'string' && req.body.store.trim() ? req.body.store : 'In store',
      title: description ? `${name}. ${description}` : name,
      name,
      quantity: quantity ?? undefined,
      purchased_at: new Date().toISOString().slice(0, 10),
      product_key: defaultProductKey('photo', name),
    });
    try {
      const { id: stagedId } = await insertStaged(query, locationId, userId, { ...input, photoKey });
      const row = await loadStaged(stagedId);
      const suggest = await suggesterFor(locationId, userId);
      res.status(201).json({ purchase: toApi(row, suggest(suggestionInput(row))) });
    } catch (err) {
      await storage.delete(photoKey);
      throw err;
    }
  }),
);

// ════════════════════════════════════════════════════════════════════
// Entry-level router (mounted at /api/staged-purchases)
// ════════════════════════════════════════════════════════════════════

export const stagedPurchasesRouter = Router();
stagedPurchasesRouter.use(authenticate);

stagedPurchasesRouter.post('/bulk-sort', asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const ids = parseIds(req.body?.ids);
  const rows = (await query<StagedRow>(
    `${SELECT_STAGED} WHERE sp.id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`,
    ids,
  )).rows;
  if (rows.length === 0) throw new NotFoundError('Purchases not found');
  const locationId = rows[0].location_id;
  if (rows.some((r) => r.location_id !== locationId)) throw new ValidationError('All purchases must be in the same location');
  if (!(await verifyLocationMembership(locationId, userId))) throw new NotFoundError('Purchases not found');
  await requireMemberOrAbove(locationId, userId, 'sort purchases');
  const bin = await binForSorting(req.body?.binId, locationId, userId);

  const pending = rows.filter((r) => r.status === 'pending');
  await withTransaction(async (q) => {
    for (const r of pending) await sortInto(q, r, bin.id, userId, r.name, itemQuantity(r.quantity === null ? null : Number(r.quantity)));
  });
  if (pending.length > 0) {
    logRouteActivity(req, {
      locationId,
      action: 'update',
      entityType: 'bin',
      entityId: bin.id,
      entityName: bin.name,
      changes: { items_added: { old: null, new: pending.map((r) => r.name) } },
    });
  }
  res.json({ sorted: pending.length, bin_id: bin.id, bin_name: bin.name });
}));

stagedPurchasesRouter.post('/bulk-skip', asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const ids = parseIds(req.body?.ids);
  const rows = (await query<StagedRow>(
    `SELECT * FROM staged_purchases WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`,
    ids,
  )).rows;
  const locationIds = new Set(rows.map((r) => r.location_id));
  if (locationIds.size !== 1) throw new ValidationError('All purchases must be in the same location');
  const locationId = rows[0].location_id;
  if (!(await verifyLocationMembership(locationId, userId))) throw new NotFoundError('Purchases not found');
  await requireMemberOrAbove(locationId, userId, 'skip purchases');
  const pendingIds = rows.filter((r) => r.status === 'pending').map((r) => r.id);
  if (pendingIds.length > 0) {
    const now = new Date().toISOString();
    await query(
      `UPDATE staged_purchases SET status = 'skipped', skip_reason = 'user', resolved_by = $1, resolved_at = $2, updated_at = $2
       WHERE id IN (${pendingIds.map((_, i) => `$${i + 3}`).join(', ')})`,
      [userId, now, ...pendingIds],
    );
  }
  res.json({ skipped: pendingIds.length });
}));

stagedPurchasesRouter.post('/:id/sort', asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const row = await loadForWrite(req.params.id, userId, 'sort purchases');
  if (row.status !== 'pending') throw new ConflictError(`Already ${row.status}`);
  const bin = await binForSorting(req.body?.binId, row.location_id, userId);
  const name = parseName(req.body?.name, row.name);
  const quantity = itemQuantity(parseQuantity(req.body?.quantity, row.quantity === null ? null : Number(row.quantity)));

  const itemId = await withTransaction((q) => sortInto(q, row, bin.id, userId, name, quantity));
  logRouteActivity(req, {
    locationId: row.location_id,
    action: 'update',
    entityType: 'bin',
    entityId: bin.id,
    entityName: bin.name,
    changes: { items_added: { old: null, new: [name] } },
  });
  res.json({
    purchase: toApi(await loadStaged(row.id)),
    item: { id: itemId, bin_id: bin.id, bin_name: bin.name, name, quantity },
  });
}));

stagedPurchasesRouter.post('/:id/skip', asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const row = await loadForWrite(req.params.id, userId, 'skip purchases');
  if (row.status !== 'pending') throw new ConflictError(`Already ${row.status}`);
  const now = new Date().toISOString();
  await query(
    `UPDATE staged_purchases SET status = 'skipped', skip_reason = 'user', resolved_by = $1, resolved_at = $2, updated_at = $2
     WHERE id = $3`,
    [userId, now, row.id],
  );
  res.json({ purchase: toApi(await loadStaged(row.id)) });
}));

// Undo: a sorted purchase's bin item goes to trash (same as deleting an item); a skipped one comes back.
stagedPurchasesRouter.post('/:id/restore', asyncHandler(async (req, res) => {
  const userId = req.user!.id;
  const row = await loadForWrite(req.params.id, userId, 'restore purchases');
  if (row.status === 'pending') throw new ConflictError('Already waiting to be sorted');
  const now = new Date().toISOString();
  await withTransaction(async (q) => {
    if (row.status === 'sorted' && row.sorted_item_id) {
      await q('UPDATE bin_items SET deleted_at = $1, updated_at = $1 WHERE id = $2 AND deleted_at IS NULL', [now, row.sorted_item_id]);
      if (row.sorted_bin_id) await q('UPDATE bins SET updated_at = $1 WHERE id = $2', [now, row.sorted_bin_id]);
    }
    await q(
      `UPDATE staged_purchases SET status = 'pending', skip_reason = NULL, sorted_bin_id = NULL, sorted_item_id = NULL,
         resolved_by = NULL, resolved_at = NULL, updated_at = $1 WHERE id = $2`,
      [now, row.id],
    );
  });
  res.json({ purchase: toApi(await loadStaged(row.id)) });
}));

// Recent failures, so a dead image link isn't re-fetched on every page view.
const imageFailures = new Map<string, number>();
const IMAGE_RETRY_MS = 60 * 60 * 1000;

stagedPurchasesRouter.get('/:id/photo', asyncHandler(async (req, res) => {
  const row = await loadStaged(req.params.id);
  if (!(await verifyLocationMembership(row.location_id, req.user!.id))) throw new NotFoundError('Photo not found');

  let key = row.photo_key;
  if (!key && row.image_url) {
    // First view of an online purchase: fetch the store's product photo once and keep it.
    const failedAt = imageFailures.get(row.id);
    if (failedAt && Date.now() - failedAt < IMAGE_RETRY_MS) throw new NotFoundError('Photo not found');
    try {
      const image = await fetchProductImage(row.image_url);
      key = `staged/${row.location_id}/${row.id}${PRODUCT_IMAGE_EXT}`;
      await storage.upload(key, image, 'image/webp');
      await query('UPDATE staged_purchases SET photo_key = $1 WHERE id = $2', [key, row.id]);
      imageFailures.delete(row.id);
    } catch (err) {
      imageFailures.set(row.id, Date.now());
      if (!(err instanceof ProductImageError)) log.warn(`Product photo for ${row.id} failed: ${err instanceof Error ? err.message : 'unknown'}`);
      throw new NotFoundError('Photo not found');
    }
  }
  if (!key) throw new NotFoundError('Photo not found');

  const ext = key.slice(key.lastIndexOf('.'));
  const mime = Object.entries(MIME_TO_EXT).find(([, e]) => e === ext)?.[0] ?? 'image/jpeg';
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  storage.readStream(key).on('error', () => res.destroy()).pipe(res);
}));

stagedPurchasesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const row = await loadForWrite(req.params.id, req.user!.id, 'delete purchases');
  await query('DELETE FROM staged_purchases WHERE id = $1', [row.id]);
  if (row.photo_key) await storage.delete(row.photo_key);
  res.json({ deleted: true });
}));
