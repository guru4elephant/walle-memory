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
    updated_at INTEGER NOT NULL,
    expires_at INTEGER
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

// Migrate existing databases that pre-date the expires_at column
const cols = (db.prepare("PRAGMA table_info(memory)").all() as { name: string }[]).map(r => r.name);
if (!cols.includes('expires_at')) {
  db.exec('ALTER TABLE memory ADD COLUMN expires_at INTEGER');
}

export interface MemoryEntry {
  key: string;
  value: string;
  description: string;
  access_count: number;
  last_accessed_at: number | null;
  updated_at: number;
  expires_at: number | null;
}

export interface KeySummary {
  key: string;
  description: string;
  updated_at: number;
  expires_at: number | null;
}

const LIVE = `(expires_at IS NULL OR expires_at > ?)`;

const stmtGet = db.prepare<[number, string], MemoryEntry>(
  `SELECT * FROM memory WHERE ${LIVE} AND key = ?`
);
const stmtUpsert = db.prepare<[string, string, string, number, number | null]>(
  `INSERT INTO memory (key, value, description, updated_at, expires_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET
     value = excluded.value,
     description = excluded.description,
     updated_at = excluded.updated_at,
     expires_at = excluded.expires_at`
);
const stmtBumpAccess = db.prepare<[number, string]>(
  `UPDATE memory SET access_count = access_count + 1, last_accessed_at = ?
   WHERE key = ?`
);
const stmtDelete = db.prepare<[string]>('DELETE FROM memory WHERE key = ?');
const stmtList = db.prepare<[number], KeySummary>(
  `SELECT key, description, updated_at, expires_at FROM memory
   WHERE ${LIVE} ORDER BY access_count DESC, updated_at DESC`
);
const stmtListPrefix = db.prepare<[number, string], KeySummary>(
  `SELECT key, description, updated_at, expires_at FROM memory
   WHERE ${LIVE} AND key LIKE ? ORDER BY access_count DESC, updated_at DESC`
);
const stmtSearch = db.prepare<[number, string], { key: string; description: string }>(
  `SELECT m.key, m.description FROM memory_fts f
   JOIN memory m ON m.rowid = f.rowid
   WHERE ${LIVE} AND memory_fts MATCH ?
   LIMIT 20`
);
const stmtDeleteExpired = db.prepare<[number]>(
  'DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at <= ?'
);
const stmtGetMeta = db.prepare<[string], { value: string }>(
  'SELECT value FROM meta WHERE key = ?'
);
const stmtSetMeta = db.prepare<[string, string, number]>(
  `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
);
const stmtAllDescriptions = db.prepare<[number], KeySummary>(
  `SELECT key, description, updated_at, expires_at FROM memory WHERE ${LIVE} ORDER BY key`
);

export function getEntry(key: string): MemoryEntry | undefined {
  const now = Date.now();
  const row = stmtGet.get(now, key);
  if (row) {
    stmtBumpAccess.run(now, key);
  }
  return row;
}

export function upsert(key: string, value: string, description: string, ttlSeconds?: number): void {
  const now = Date.now();
  const expires_at = ttlSeconds != null ? now + ttlSeconds * 1000 : null;
  stmtUpsert.run(key, value, description, now, expires_at);
}

export function deleteEntry(key: string): boolean {
  const info = stmtDelete.run(key);
  return info.changes > 0;
}

export function listKeys(prefix?: string): KeySummary[] {
  const now = Date.now();
  if (prefix) {
    return stmtListPrefix.all(now, `${prefix}%`);
  }
  return stmtList.all(now);
}

export function searchKeys(query: string): { key: string; description: string }[] {
  return stmtSearch.all(Date.now(), query);
}

export function getAllDescriptions(): KeySummary[] {
  return stmtAllDescriptions.all(Date.now());
}

export function deleteExpired(): number {
  const info = stmtDeleteExpired.run(Date.now());
  return info.changes;
}

export function getMeta(key: string): string | undefined {
  return stmtGetMeta.get(key)?.value;
}

export function setMeta(key: string, value: string): void {
  stmtSetMeta.run(key, value, Date.now());
}
