import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('0016 dex metadata group key migration', () => {
  it('consolidates aliases by code and preserves every non-empty note', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY);
      CREATE TABLE photo (id TEXT PRIMARY KEY);
      CREATE TABLE observation (
        userId TEXT, speciesName TEXT, speciesCode TEXT
      );
      CREATE TABLE dex_meta (
        userId TEXT, speciesName TEXT, speciesCode TEXT,
        addedDate TEXT, bestPhotoId TEXT, notes TEXT
      );
      INSERT INTO user (id) VALUES ('u1');
      INSERT INTO observation VALUES
        ('u1', 'Northern Cardinal', 'norcar'),
        ('u1', 'Northern Cardinal (Cardinalis cardinalis)', 'norcar');
      INSERT INTO dex_meta VALUES
        ('u1', 'Northern Cardinal', 'norcar', '2025-02-01', NULL, ''),
        ('u1', 'Northern Cardinal (Cardinalis cardinalis)', 'norcar', '2025-01-01', NULL, 'feeder');
    `)

    db.exec(readFileSync('migrations/0016_dex_meta_group_key.sql', 'utf8'))

    expect(db.prepare('SELECT groupKey, addedDate, notes FROM dex_meta').all()).toEqual([{
      groupKey: 'code:norcar',
      addedDate: '2025-01-01',
      notes: 'feeder',
    }])
  })
})