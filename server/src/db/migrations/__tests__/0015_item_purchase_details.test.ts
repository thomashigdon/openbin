import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrations } from '../index.js';
import { runSqliteMigrations } from '../runner.js';

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'schema.sqlite.sql'), 'utf-8');

/** A database as it was before 0015: bin_items without the new columns, no barcode cache. */
function preUpgradeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  runSqliteMigrations(db, migrations); // bootstrap: records every migration as applied
  db.exec(`
    DROP TABLE barcode_lookups;
    DROP TABLE bin_items;
    CREATE TABLE bin_items (
      id         TEXT PRIMARY KEY,
      bin_id     TEXT NOT NULL REFERENCES bins(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      quantity   INTEGER DEFAULT NULL,
      position   INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    DELETE FROM schema_migrations WHERE name = '0015_item_purchase_details';
  `);
  return db;
}

describe('migration 0015_item_purchase_details', () => {
  it('upgrades an existing database the way startup does (schema file first, then migrations)', () => {
    const db = preUpgradeDb();
    db.exec(`
      INSERT INTO locations (id, name, invite_code) VALUES ('L', 'Home', 'inv');
      INSERT INTO bins (id, short_code, location_id, name) VALUES ('B', 'ABCDEF', 'L', 'Garage');
      INSERT INTO bin_items (id, bin_id, name) VALUES ('sorted', 'B', 'Drill'), ('manual', 'B', 'Hammer');
      INSERT INTO staged_purchases (id, location_id, source, title, name, price, purchased_at, store, status, sorted_bin_id, sorted_item_id)
        VALUES ('P', 'L', 'amazon', 'DEWALT Drill', 'Drill', 129.5, '2026-11-02', 'Amazon', 'sorted', 'B', 'sorted');
    `);

    // The exact startup sequence: must not trip over columns the migration hasn't added yet.
    expect(() => db.exec(SCHEMA)).not.toThrow();
    runSqliteMigrations(db, migrations);

    const cols = (db.prepare('PRAGMA table_info(bin_items)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['unit_price', 'purchased_at', 'purchased_from', 'barcode']));
    const idx = (db.prepare('PRAGMA index_list(bin_items)').all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain('idx_bin_items_barcode');
    const cache = (db.prepare('PRAGMA table_info(barcode_lookups)').all() as { name: string }[]).map((c) => c.name);
    expect(cache).toContain('image_key');

    const items = db.prepare('SELECT id, unit_price, purchased_at, purchased_from FROM bin_items ORDER BY id').all();
    expect(items).toEqual([
      { id: 'manual', unit_price: null, purchased_at: null, purchased_from: null },
      { id: 'sorted', unit_price: 129.5, purchased_at: '2026-11-02', purchased_from: 'Amazon' },
    ]);

    // And the next start is a no-op.
    expect(() => db.exec(SCHEMA)).not.toThrow();
    runSqliteMigrations(db, migrations);
    db.close();
  });
});
