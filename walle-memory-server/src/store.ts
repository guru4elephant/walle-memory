import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createHash, randomBytes } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH ?? path.join(DEFAULT_DB_DIR, 'memory.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory (
    key TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    value TEXT NOT NULL,
    description TEXT NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at INTEGER,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS memory_pk ON memory(tenant_id, key);

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

// ── Migrations for databases created before multi-tenant ────────────────────
{
  const cols = (db.prepare("PRAGMA table_info(memory)").all() as { name: string }[]).map(r => r.name);
  if (!cols.includes('expires_at')) {
    db.exec('ALTER TABLE memory ADD COLUMN expires_at INTEGER');
  }
  if (!cols.includes('tenant_id')) {
    db.exec(`ALTER TABLE memory ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    // Re-create the unique index now that tenant_id exists
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS memory_pk ON memory(tenant_id, key)`);
    // Drop old primary key constraint if it was just (key)
    // SQLite doesn't support DROP PRIMARY KEY; the table was created with
    // key TEXT PRIMARY KEY in the old schema — we leave it as is; the new
    // unique index handles the multi-tenant uniqueness.
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  created_at: number;
}

export interface MemoryEntry {
  key: string;
  tenant_id: string;
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

// ── Prepared statements ──────────────────────────────────────────────────────

const LIVE = `(expires_at IS NULL OR expires_at > ?)`;

const stmtGetTenantByKey = db.prepare<[string], { id: string; name: string; created_at: number }>(
  `SELECT id, name, created_at FROM tenants WHERE api_key_hash = ?`
);
const stmtInsertTenant = db.prepare<[string, string, string, number]>(
  `INSERT INTO tenants (id, name, api_key_hash, created_at) VALUES (?, ?, ?, ?)`
);
const stmtListTenants = db.prepare<[], { id: string; name: string; created_at: number }>(
  `SELECT id, name, created_at FROM tenants ORDER BY created_at ASC`
);
const stmtDeleteTenant = db.prepare<[string]>(
  `DELETE FROM tenants WHERE id = ?`
);

const stmtGet = db.prepare<[number, string, string], MemoryEntry>(
  `SELECT * FROM memory WHERE ${LIVE} AND tenant_id = ? AND key = ?`
);
const stmtUpsert = db.prepare<[string, string, string, string, number, number | null]>(
  `INSERT INTO memory (tenant_id, key, value, description, updated_at, expires_at)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(tenant_id, key) DO UPDATE SET
     value = excluded.value,
     description = excluded.description,
     updated_at = excluded.updated_at,
     expires_at = excluded.expires_at`
);
const stmtBumpAccess = db.prepare<[number, string, string]>(
  `UPDATE memory SET access_count = access_count + 1, last_accessed_at = ?
   WHERE tenant_id = ? AND key = ?`
);
const stmtDelete = db.prepare<[string, string]>(
  `DELETE FROM memory WHERE tenant_id = ? AND key = ?`
);
const stmtList = db.prepare<[number, string], KeySummary>(
  `SELECT key, description, updated_at, expires_at FROM memory
   WHERE ${LIVE} AND tenant_id = ? ORDER BY access_count DESC, updated_at DESC`
);
const stmtListPrefix = db.prepare<[number, string, string], KeySummary>(
  `SELECT key, description, updated_at, expires_at FROM memory
   WHERE ${LIVE} AND tenant_id = ? AND key LIKE ? ORDER BY access_count DESC, updated_at DESC`
);
const stmtSearch = db.prepare<[number, string, string], { key: string; description: string }>(
  `SELECT m.key, m.description FROM memory_fts f
   JOIN memory m ON m.rowid = f.rowid
   WHERE ${LIVE} AND m.tenant_id = ? AND memory_fts MATCH ?
   LIMIT 20`
);
const stmtDeleteExpired = db.prepare<[number]>(
  `DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at <= ?`
);
const stmtGetMeta = db.prepare<[string], { value: string }>(
  `SELECT value FROM meta WHERE key = ?`
);
const stmtSetMeta = db.prepare<[string, string, number]>(
  `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
);
const stmtAllDescriptions = db.prepare<[number, string], KeySummary>(
  `SELECT key, description, updated_at, expires_at FROM memory
   WHERE ${LIVE} AND tenant_id = ? ORDER BY key`
);

// ── Tenant functions ──────────────────────────────────────────────────────────

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function createTenant(name: string): { tenant: Tenant; apiKey: string } {
  const id = randomBytes(8).toString('hex');
  const apiKey = randomBytes(24).toString('hex');
  const now = Date.now();
  stmtInsertTenant.run(id, name, hashKey(apiKey), now);
  return { tenant: { id, name, created_at: now }, apiKey };
}

export function resolveTenant(rawApiKey: string): Tenant | undefined {
  return stmtGetTenantByKey.get(hashKey(rawApiKey)) as Tenant | undefined;
}

export function listTenants(): Tenant[] {
  return stmtListTenants.all() as Tenant[];
}

export function deleteTenant(id: string): boolean {
  const info = stmtDeleteTenant.run(id);
  return info.changes > 0;
}

// ── Memory functions ──────────────────────────────────────────────────────────

export function getEntry(tenantId: string, key: string): MemoryEntry | undefined {
  const now = Date.now();
  const row = stmtGet.get(now, tenantId, key);
  if (row) {
    stmtBumpAccess.run(now, tenantId, key);
  }
  return row;
}

export function upsert(tenantId: string, key: string, value: string, description: string, ttlSeconds?: number): void {
  const now = Date.now();
  const expires_at = ttlSeconds != null ? now + ttlSeconds * 1000 : null;
  stmtUpsert.run(tenantId, key, value, description, now, expires_at);
}

export function deleteEntry(tenantId: string, key: string): boolean {
  const info = stmtDelete.run(tenantId, key);
  return info.changes > 0;
}

export function listKeys(tenantId: string, prefix?: string): KeySummary[] {
  const now = Date.now();
  if (prefix) {
    return stmtListPrefix.all(now, tenantId, `${prefix}%`);
  }
  return stmtList.all(now, tenantId);
}

export function searchKeys(tenantId: string, query: string): { key: string; description: string }[] {
  return stmtSearch.all(Date.now(), tenantId, query);
}

export function getAllDescriptions(tenantId: string): KeySummary[] {
  return stmtAllDescriptions.all(Date.now(), tenantId);
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
