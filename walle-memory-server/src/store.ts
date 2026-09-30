import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH ?? path.join(DEFAULT_DB_DIR, 'memory.db');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS memory (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    key, description,
    content='memory',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, key, description)
    VALUES (new.rowid, new.key, new.description);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, key, description)
    VALUES ('delete', old.rowid, old.key, old.description);
  END;

  CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, key, description)
    VALUES ('delete', old.rowid, old.key, old.description);
    INSERT INTO memory_fts(rowid, key, description)
    VALUES (new.rowid, new.key, new.description);
  END;

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

export interface MemoryEntry {
  key: string;
  value: string;
  description: string;
  access_count: number;
  last_accessed_at: number | null;
  updated_at: number;
}

export interface KeySummary {
  key: string;
  description: string;
  updated_at: number;
}

const stmtGet = db.prepare<[string], MemoryEntry>(
  'SELECT * FROM memory WHERE key = ?'
);
const stmtUpsert = db.prepare<[string, string, string, number]>(
  `INSERT INTO memory (key, value, description, updated_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET
     value = excluded.value,
     description = excluded.description,
     updated_at = excluded.updated_at`
);
const stmtBumpAccess = db.prepare<[number, string]>(
  `UPDATE memory SET access_count = access_count + 1, last_accessed_at = ?
   WHERE key = ?`
);
const stmtDelete = db.prepare<[string]>('DELETE FROM memory WHERE key = ?');
const stmtList = db.prepare<[], KeySummary>(
  'SELECT key, description, updated_at FROM memory ORDER BY access_count DESC, updated_at DESC'
);
const stmtListPrefix = db.prepare<[string], KeySummary>(
  `SELECT key, description, updated_at FROM memory
   WHERE key LIKE ? ORDER BY access_count DESC, updated_at DESC`
);
const stmtSearch = db.prepare<[string], { key: string; description: string }>(
  `SELECT m.key, m.description FROM memory_fts f
   JOIN memory m ON m.rowid = f.rowid
   WHERE memory_fts MATCH ?
   LIMIT 20`
);
const stmtGetMeta = db.prepare<[string], { value: string }>(
  'SELECT value FROM meta WHERE key = ?'
);
const stmtSetMeta = db.prepare<[string, string, number]>(
  `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
);
const stmtAllDescriptions = db.prepare<[], KeySummary>(
  'SELECT key, description, updated_at FROM memory ORDER BY key'
);

export function getEntry(key: string): MemoryEntry | undefined {
  const row = stmtGet.get(key);
  if (row) {
    stmtBumpAccess.run(Date.now(), key);
  }
  return row;
}

export function upsert(key: string, value: string, description: string): void {
  stmtUpsert.run(key, value, description, Date.now());
}

export function deleteEntry(key: string): boolean {
  const info = stmtDelete.run(key);
  return info.changes > 0;
}

export function listKeys(prefix?: string): KeySummary[] {
  if (prefix) {
    return stmtListPrefix.all(`${prefix}%`);
  }
  return stmtList.all();
}

export function searchKeys(query: string): { key: string; description: string }[] {
  return stmtSearch.all(query);
}

export function getAllDescriptions(): KeySummary[] {
  return stmtAllDescriptions.all();
}

export function getMeta(key: string): string | undefined {
  return stmtGetMeta.get(key)?.value;
}

export function setMeta(key: string, value: string): void {
  stmtSetMeta.run(key, value, Date.now());
}
