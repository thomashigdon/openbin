import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { lookupBarcode } from '../lib/barcodeLookup.js';
import { verifyLocationMembership } from '../lib/binAccess.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../lib/httpErrors.js';
import { normalizeBarcode } from '../lib/itemDetails.js';
import { createLogger } from '../lib/logger.js';
import { fetchProductImage, PRODUCT_IMAGE_EXT, ProductImageError } from '../lib/stagedPurchaseImages.js';
import { storage } from '../lib/storage.js';
import { authenticate } from '../middleware/auth.js';

const log = createLogger('barcodes');

const router = Router();

router.use(authenticate);

// GET /api/barcodes/:code?location_id=X — items in the location carrying this barcode,
// plus the product it names (from the lookup cache or a public product database).
router.get('/:code', asyncHandler(async (req, res) => {
  const code = normalizeBarcode(req.params.code);
  if (!code) throw new ValidationError('code must be 8–14 digits (UPC/EAN)');
  const locationId = req.query.location_id as string | undefined;
  if (!locationId) throw new ValidationError('location_id is required');
  if (!await verifyLocationMembership(locationId, req.user!.id)) {
    throw new ForbiddenError('Not a member of this location');
  }

  const matches = await query<{
    id: string;
    name: string;
    quantity: number | null;
    bin_id: string;
    bin_name: string;
    bin_icon: string;
    bin_color: string;
  }>(
    `SELECT bi.id, bi.name, bi.quantity, bi.bin_id, b.name AS bin_name, b.icon AS bin_icon, b.color AS bin_color
     FROM bin_items bi
     JOIN bins b ON b.id = bi.bin_id
     WHERE bi.barcode = $1
       AND b.location_id = $2
       AND b.deleted_at IS NULL
       AND bi.deleted_at IS NULL
       AND (b.visibility = 'location' OR b.created_by = $3)
     ORDER BY b.name, bi.name`,
    [code, locationId, req.user!.id],
  );

  // Items already tagged with the code name it well enough; skip the outside lookup.
  const product = matches.rows.length > 0 && req.query.lookup !== 'true' ? null : await lookupBarcode(code);

  res.json({ code, product, matches: matches.rows });
}));

// Recent failures, so a dead image link isn't re-fetched on every view.
const imageFailures = new Map<string, number>();
const IMAGE_RETRY_MS = 60 * 60 * 1000;

// GET /api/barcodes/:code/image — the looked-up product's photo. Product databases host images on
// their own CDNs, which the CSP (img-src 'self') won't load, so fetch it once, shrink it, and serve it.
router.get('/:code/image', asyncHandler(async (req, res) => {
  const code = normalizeBarcode(req.params.code);
  if (!code) throw new NotFoundError('Image not found');
  const row = (await query<{ image_url: string | null; image_key: string | null }>(
    'SELECT image_url, image_key FROM barcode_lookups WHERE code = $1',
    [code],
  )).rows[0];

  let key = row?.image_key ?? null;
  if (!key && row?.image_url) {
    const failedAt = imageFailures.get(code);
    if (failedAt && Date.now() - failedAt < IMAGE_RETRY_MS) throw new NotFoundError('Image not found');
    try {
      const image = await fetchProductImage(row.image_url);
      key = `barcodes/${code}${PRODUCT_IMAGE_EXT}`;
      await storage.upload(key, image, 'image/webp');
      await query('UPDATE barcode_lookups SET image_key = $1 WHERE code = $2', [key, code]);
      imageFailures.delete(code);
    } catch (err) {
      imageFailures.set(code, Date.now());
      if (!(err instanceof ProductImageError)) log.warn(`Product image for ${code} failed: ${err instanceof Error ? err.message : 'unknown'}`);
      throw new NotFoundError('Image not found');
    }
  }
  if (!key) throw new NotFoundError('Image not found');

  res.setHeader('Content-Type', 'image/webp');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  storage.readStream(key).on('error', () => res.destroy()).pipe(res);
}));

export default router;
