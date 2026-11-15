import type { Migration } from './types.js';

// Purchase details and barcodes on bin items, plus a cache of product lookups by barcode.
// Mirrors the bin_items / barcode_lookups blocks in schema.sqlite.sql / schema.pg.sql (fresh installs use those).

// Items already put away from To Be Sorted inherit what the purchase recorded.
const BACKFILL_SQL = `
UPDATE bin_items SET
  unit_price = (SELECT sp.price FROM staged_purchases sp WHERE sp.sorted_item_id = bin_items.id),
  purchased_at = (SELECT sp.purchased_at FROM staged_purchases sp WHERE sp.sorted_item_id = bin_items.id),
  purchased_from = (SELECT NULLIF(sp.store, '') FROM staged_purchases sp WHERE sp.sorted_item_id = bin_items.id)
WHERE id IN (SELECT sorted_item_id FROM staged_purchases WHERE status = 'sorted' AND sorted_item_id IS NOT NULL);
`;

const SQLITE_SQL = `
ALTER TABLE bin_items ADD COLUMN unit_price REAL;
ALTER TABLE bin_items ADD COLUMN purchased_at TEXT;
ALTER TABLE bin_items ADD COLUMN purchased_from TEXT;
ALTER TABLE bin_items ADD COLUMN barcode TEXT;
CREATE INDEX IF NOT EXISTS idx_bin_items_barcode ON bin_items(barcode);
CREATE TABLE IF NOT EXISTS barcode_lookups (
  code         TEXT PRIMARY KEY,
  name         TEXT,
  brand        TEXT,
  image_url    TEXT,
  image_key    TEXT,
  source       TEXT,
  looked_up_at TEXT NOT NULL DEFAULT (datetime('now'))
);
${BACKFILL_SQL}`;

const PG_SQL = `
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS unit_price DOUBLE PRECISION;
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS purchased_at TEXT;
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS purchased_from TEXT;
ALTER TABLE bin_items ADD COLUMN IF NOT EXISTS barcode TEXT;
CREATE INDEX IF NOT EXISTS idx_bin_items_barcode ON bin_items(barcode);
CREATE TABLE IF NOT EXISTS barcode_lookups (
  code         TEXT PRIMARY KEY,
  name         TEXT,
  brand        TEXT,
  image_url    TEXT,
  image_key    TEXT,
  source       TEXT,
  looked_up_at TEXT NOT NULL DEFAULT (NOW())
);
${BACKFILL_SQL}`;

export const itemPurchaseDetails: Migration = {
  name: '0015_item_purchase_details',
  sqlite(db) {
    db.exec(SQLITE_SQL);
  },
  async postgres(pool) {
    await pool.query(PG_SQL);
  },
};
