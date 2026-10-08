-- Fresh D1 database only. Do not apply directly over a legacy SQLite schema.
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  api_key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
-- statement-breakpoint
CREATE TABLE memory (
  key TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  description TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  UNIQUE (tenant_id, key)
);
-- statement-breakpoint
CREATE INDEX memory_tenant_expiry ON memory(tenant_id, expires_at);
-- statement-breakpoint
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- statement-breakpoint
CREATE VIRTUAL TABLE memory_fts USING fts5(
  key, description,
  content='memory',
  content_rowid='rowid'
);
-- statement-breakpoint
CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, key, description)
  VALUES (new.rowid, new.key, new.description);
END;
-- statement-breakpoint
CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, key, description)
  VALUES ('delete', old.rowid, old.key, old.description);
END;
-- statement-breakpoint
CREATE TRIGGER memory_au AFTER UPDATE OF key, description ON memory
WHEN old.key IS NOT new.key OR old.description IS NOT new.description
BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, key, description)
  VALUES ('delete', old.rowid, old.key, old.description);
  INSERT INTO memory_fts(rowid, key, description)
  VALUES (new.rowid, new.key, new.description);
END;
