import type { Migration } from './types.js';

// Mirrors the staged_purchases block in schema.sqlite.sql / schema.pg.sql (fresh installs use those).
const SQLITE_SQL = `
-- Purchases waiting to be put away (online orders, in-store photos)
CREATE TABLE IF NOT EXISTS staged_purchases (
  id              TEXT PRIMARY KEY,
  location_id     TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,
  external_id     TEXT,
  product_key     TEXT,
  store           TEXT NOT NULL DEFAULT '',
  order_ref       TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL,
  name            TEXT NOT NULL,
  quantity        INTEGER,
  price           REAL,
  currency        TEXT,
  purchased_at    TEXT,
  product_url     TEXT,
  image_url       TEXT,
  photo_key       TEXT,
  delivered       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sorted', 'skipped')),
  skip_reason     TEXT,
  sorted_bin_id   TEXT REFERENCES bins(id) ON DELETE SET NULL,
  sorted_item_id  TEXT,
  resolved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TEXT,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(location_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_staged_purchases_location_status
  ON staged_purchases(location_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_staged_purchases_product_key
  ON staged_purchases(location_id, product_key);
`;

const PG_SQL = `
-- Purchases waiting to be put away (online orders, in-store photos)
CREATE TABLE IF NOT EXISTS staged_purchases (
  id              TEXT PRIMARY KEY,
  location_id     TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  source          TEXT NOT NULL,
  external_id     TEXT,
  product_key     TEXT,
  store           TEXT NOT NULL DEFAULT '',
  order_ref       TEXT NOT NULL DEFAULT '',
  title           TEXT NOT NULL,
  name            TEXT NOT NULL,
  quantity        INTEGER,
  price           DOUBLE PRECISION,
  currency        TEXT,
  purchased_at    TEXT,
  product_url     TEXT,
  image_url       TEXT,
  photo_key       TEXT,
  delivered       INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sorted', 'skipped')),
  skip_reason     TEXT,
  sorted_bin_id   TEXT REFERENCES bins(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
  sorted_item_id  TEXT,
  resolved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     TEXT,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (NOW()),
  updated_at      TEXT NOT NULL DEFAULT (NOW()),
  UNIQUE(location_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_staged_purchases_location_status
  ON staged_purchases(location_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_staged_purchases_product_key
  ON staged_purchases(location_id, product_key);
`;

export const stagedPurchases: Migration = {
  name: '0014_staged_purchases',
  sqlite(db) {
    db.exec(SQLITE_SQL);
  },
  async postgres(pool) {
    await pool.query(PG_SQL);
  },
};
